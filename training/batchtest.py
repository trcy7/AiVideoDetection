from __future__ import annotations

import argparse
from pathlib import Path

VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mpg", ".mpeg", ".wmv"}


def _videos(folder: str | None) -> list[Path]:
    if not folder:
        return []
    p = Path(folder)
    if not p.exists():
        raise SystemExit(f"folder not found: {p}")
    return sorted(f for f in p.rglob("*") if f.suffix.lower() in VIDEO_EXT)


def _auc(pairs: list[tuple[float, int]]) -> float | None:
    """Rank-based AUC (Mann-Whitney) so no sklearn dependency. None if a class is missing."""
    ranked = sorted(pairs, key=lambda p: p[0])
    ranks = [0.0] * len(ranked)
    i = 0
    while i < len(ranked):
        j = i
        while j < len(ranked) and ranked[j][0] == ranked[i][0]:
            j += 1
        avg = (i + j - 1) / 2.0 + 1.0            # 1-based average rank over ties
        for k in range(i, j):
            ranks[k] = avg
        i = j
    n_pos = sum(1 for _, y in ranked if y == 1)
    n_neg = len(ranked) - n_pos
    if n_pos == 0 or n_neg == 0:
        return None
    sum_pos = sum(rk for rk, (_, y) in zip(ranks, ranked) if y == 1)
    return (sum_pos - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--real", help="folder of KNOWN-REAL videos")
    ap.add_argument("--ai", help="folder of KNOWN-AI videos")
    args = ap.parse_args()

    if not args.real and not args.ai:
        raise SystemExit("give at least one of --real / --ai")

    from src.inference import Predictor

    print("loading model (once) ...")
    predictor = Predictor(args.checkpoint)
    icfg = predictor.cfg["inference"]
    t_star = float(icfg.get("decision_threshold", 0.5)) * 100.0
    rb = float(icfg.get("verdict_real_below", 35))
    fa = float(icfg.get("verdict_fake_above", 65))
    print(f"decision threshold t* = {t_star:.1f} | bands real<{rb} / AI>{fa}\n")

    jobs = [(p, 0, "real") for p in _videos(args.real)] + \
           [(p, 1, "ai") for p in _videos(args.ai)]
    if not jobs:
        raise SystemExit("no video files found in the given folder(s)")

    # 2x2 on the model's own decision threshold t*; plus a 3-way verdict tally.
    tp = tn = fp = fn = 0
    unc = 0
    fused_scores: list[tuple[float, int]] = []
    branch_scores: dict[str, list[tuple[float, int]]] = {}
    print(f"{'file':<40} {'truth':<6} {'verdict':<10} {'score':>6}  {'2way':>5}")
    print("-" * 74)
    for path, truth, truth_name in jobs:
        try:
            r = predictor.predict(path)
        except Exception as e:
            print(f"{path.name[:38]:<40} {truth_name:<6} {'ERROR':<10} {'--':>6}  ({type(e).__name__})")
            continue
        score = r["fakeScore"]
        verdict = r["verdict"]
        fused_scores.append((score, truth))
        bs = r.get("branchScores", {})
        for key, slot in (("spatial", "spatial"), ("opticalFlow", "temporal"),
                          ("frequency", "frequency"), ("motion", "motion")):
            v = bs.get(key)
            if v is not None:
                branch_scores.setdefault(slot, []).append((float(v), truth))
        pred = 1 if score >= t_star else 0          # 2-way call at t*
        ok = "OK" if pred == truth else "XX"
        if verdict == "uncertain":
            unc += 1
        if truth == 1 and pred == 1: tp += 1
        elif truth == 0 and pred == 0: tn += 1
        elif truth == 0 and pred == 1: fp += 1
        elif truth == 1 and pred == 0: fn += 1
        print(f"{path.name[:38]:<40} {truth_name:<6} {verdict:<10} {score:>6.1f}  {ok:>5}")

    n = tp + tn + fp + fn
    if n == 0:
        raise SystemExit("no videos scored")
    acc = (tp + tn) / n
    print("\n=== RESULT (2-way at t*={:.0f}) ===".format(t_star))
    print(f"videos scored     : {n}")
    print(f"accuracy          : {acc:.3f}")
    if tp + fn:
        print(f"AI recall (caught): {tp}/{tp+fn} = {tp/(tp+fn):.2f}")
    if tn + fp:
        print(f"real specificity  : {tn}/{tn+fp} = {tn/(tn+fp):.2f}  (1 - false-alarm rate)")
    print(f"confusion         : [[TN {tn}, FP {fp}], [FN {fn}, TP {tp}]]")
    print(f"landed 'uncertain': {unc}/{n} on the 3-way bands (not wrong, just cautious)")

    # Per-branch AUC: does each branch discriminate on its own? 0.5 = chance (didn't
    # learn), ~0.9 = strong. Needs both real and AI videos to compute.
    print("\n=== BRANCH DISCRIMINATION (AUC) ===")
    fused_auc = _auc(fused_scores)
    print(f"  fused   : {fused_auc:.3f}" if fused_auc is not None else "  fused   : n/a (need both classes)")
    for slot in ("spatial", "temporal", "frequency", "motion"):
        if slot not in branch_scores:
            continue
        a = _auc(branch_scores[slot])
        note = "" if a is None else ("   <- near chance: this branch didn't learn" if a < 0.6 else "")
        print(f"  {slot:<8}: {a:.3f}{note}" if a is not None else f"  {slot:<8}: n/a (need both classes)")
    print("\nHow to read this:")
    if acc >= 0.80:
        print("  ~0.85 is expected -> the model works; this is its real ceiling.")
        print("  To do BETTER needs a retrain with more data, not a serving tweak.")
    elif acc >= 0.65:
        print("  mediocre -> partly the ceiling, partly your videos may be OOD")
        print("  (high-res / a generator the model is weak on). Send me the table.")
    else:
        print("  ~random -> a REAL problem (decode/preprocessing skew or bad labels).")
        print("  Paste this whole output to me and I will find it.")


if __name__ == "__main__":
    main()
