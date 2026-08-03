"""
diagnose_gaps.py -- WHERE does the model fail, and WHAT data would fix it?

Runs your model over a folder of labelled test videos and slices the errors by
the conditions you can actually collect more of: orientation (portrait vs
landscape), lighting (dark/normal/bright), resolution, and source family.
The slices with the worst accuracy AND enough samples are the data gaps -- the
report ends with a prioritised "collect more of X" list.

USAGE (from the training\ folder):
    python diagnose_gaps.py --videos PATH\TO\test_videos --checkpoint models\best_run4_ep7.pt

Labels are inferred, no manual tagging needed:
  * folder:   any video under a  real/  folder  -> real
              any under  ai_generated/  ai/  fake/  -> ai_generated
  * filename: pex_/pexl_/ugc_/vis_  -> real     gvb_/avg_/dact_ -> ai_generated
A video with no inferable label is skipped (and reported).

Output: a printed report + gap_report.csv (per-video) for your own slicing.
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
import warnings
from collections import defaultdict
from pathlib import Path

# quiet the two harmless startup warnings BEFORE the heavy imports fire them:
#  * albumentations phones home for a version check (fails offline -> noisy)
#  * timm prints a model-name-rename notice
os.environ.setdefault("NO_ALBUMENTATIONS_UPDATE", "1")
warnings.filterwarnings("ignore")

# make `src` importable no matter the current directory
sys.path.insert(0, str(Path(__file__).resolve().parent))

import cv2
import numpy as np
import torch

from src.inference import _predict_hybrid, _normalize_cfg, _adapt_state_dict
from src.model import build_model
from src.utils import get_device, load_checkpoint

VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".mpg", ".mpeg", ".wmv"}
REAL_PREFIXES = ("ugc_", "vis_", "pexl_", "pex_")
AI_PREFIXES = ("gvb_", "avg_", "dact_")

# human-readable source family from the filename prefix
FAMILY = {
    "ugc_": "youtube_ugc (wild)", "vis_": "phone_camera", "pexl_": "pexels_landscape",
    "pex_": "pexels_portrait", "gvb_": "genvidbench(old-gen)", "avg_": "avgen(modern)",
    "dact_": "deepaction",
}


# ------------------------------------------------------------------ labelling
def label_of(path: Path) -> str | None:
    parts = {p.lower() for p in path.parts}
    if {"ai_generated", "ai", "fake"} & parts:
        return "ai_generated"
    if "real" in parts:
        return "real"
    s = path.stem
    if s.startswith(AI_PREFIXES):
        return "ai_generated"
    if s.startswith(REAL_PREFIXES):
        return "real"
    return None


def family_of(path: Path) -> str:
    for pref, fam in FAMILY.items():
        if path.stem.startswith(pref):
            return fam
    return "unknown"


# ------------------------------------------------------------------ probing
def probe(path: Path) -> dict:
    """Cheap visual stats: orientation, brightness, resolution -- from a few
    decoded frames (sequential, so WebM works)."""
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        return {}
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    lums, taken = [], 0
    while taken < 5:
        ok, bgr = cap.read()
        if not ok:
            break
        lums.append(float(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).mean()))
        # skip ahead a little without relying on seeking
        for _ in range(10):
            cap.read()
        taken += 1
    cap.release()
    if not w or not h:
        return {}
    bright = float(np.mean(lums)) if lums else None
    return {
        "width": w, "height": h,
        "orientation": ("portrait" if h > w * 1.05 else
                        "landscape" if w > h * 1.05 else "square"),
        "resolution": ("low(<=360p)" if min(w, h) <= 360 else
                       "medium(<=720p)" if min(w, h) <= 720 else "high(>720p)"),
        "brightness": bright,
        "lighting": (None if bright is None else
                     "dark" if bright < 60 else
                     "bright" if bright > 175 else "normal"),
    }


# ------------------------------------------------------------------ model
def load_once(checkpoint: Path):
    device = get_device()
    ckpt = load_checkpoint(checkpoint, map_location=device)
    cfg = _normalize_cfg(ckpt["config"])
    model = build_model(cfg).to(device)
    model.load_state_dict(_adapt_state_dict(model, ckpt["model"]))
    model.eval()
    thr = float(cfg["inference"].get("decision_threshold", 0.5)) * 100.0
    print(f"loaded {checkpoint.name}  |  decision threshold = {thr:.1f}/100")
    return model, cfg, device, thr


# ------------------------------------------------------------------ reporting
def slice_report(rows: list[dict], key: str, min_n: int = 5):
    """Per-value accuracy for one slicing dimension."""
    groups: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        v = r.get(key)
        if v is not None:
            groups[str(v)].append(r)
    out = []
    for v, g in groups.items():
        n = len(g)
        acc = sum(x["correct"] for x in g) / n
        reals = [x for x in g if x["label"] == "real"]
        ais = [x for x in g if x["label"] == "ai_generated"]
        # FPR = real called AI ; miss = AI called real
        fpr = (sum(not x["correct"] for x in reals) / len(reals)) if reals else None
        miss = (sum(not x["correct"] for x in ais) / len(ais)) if ais else None
        out.append(dict(value=v, n=n, acc=acc, fpr=fpr, miss=miss,
                        n_real=len(reals), n_ai=len(ais)))
    return sorted(out, key=lambda d: d["acc"])


def fmt(x, pct=True):
    if x is None:
        return "   -"
    return f"{x*100:4.0f}%" if pct else f"{x}"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--videos", required=True, help="folder of labelled test videos")
    ap.add_argument("--checkpoint", required=True, help="path to a .pt checkpoint")
    ap.add_argument("--limit", type=int, default=None, help="cap videos (quick pass)")
    ap.add_argument("--min-n", type=int, default=5,
                    help="min samples for a slice to be trusted (default 5)")
    args = ap.parse_args()

    root = Path(args.videos)
    vids = sorted(p for p in root.rglob("*") if p.suffix.lower() in VIDEO_EXTS and p.is_file())
    if args.limit:
        vids = vids[: args.limit]
    if not vids:
        raise SystemExit(f"no videos found under {root}")

    model, cfg, device, thr = load_once(Path(args.checkpoint))
    print(f"analysing {len(vids)} videos ...\n")

    rows, skipped, failed = [], 0, 0
    for i, p in enumerate(vids, 1):
        lab = label_of(p)
        if lab is None:
            skipped += 1
            continue
        try:
            score = _predict_hybrid(p, model, cfg, device)["fakeScore"]
        except Exception as e:
            failed += 1
            print(f"  ! {p.name[:40]}: {type(e).__name__}: {str(e)[:40]}")
            continue
        meta = probe(p)
        pred = "ai_generated" if score >= thr else "real"
        ok = int(pred == lab)
        rows.append(dict(
            file=p.name, label=lab, score=round(score, 1), pred=pred,
            correct=ok, family=family_of(p),
            orientation=meta.get("orientation"), lighting=meta.get("lighting"),
            resolution=meta.get("resolution"),
            width=meta.get("width"), height=meta.get("height"),
            brightness=(round(meta["brightness"], 1) if meta.get("brightness") else None),
        ))
        # live progress every video so a slow run never LOOKS stuck
        mark = "OK " if ok else "XX "
        print(f"  [{i:>3}/{len(vids)}] {mark} {lab:<13} score={score:5.1f} "
              f"{meta.get('orientation','?'):<9} {p.name[:34]}", flush=True)

    if not rows:
        raise SystemExit("no labelled videos analysed (check folder names / prefixes)")

    # ---- write per-video CSV ----
    out_csv = Path("gap_report.csv")
    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        wtr = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        wtr.writeheader(); wtr.writerows(rows)

    n = len(rows)
    reals = [r for r in rows if r["label"] == "real"]
    ais = [r for r in rows if r["label"] == "ai_generated"]
    overall = sum(r["correct"] for r in rows) / n
    fpr = sum(not r["correct"] for r in reals) / len(reals) if reals else 0
    miss = sum(not r["correct"] for r in ais) / len(ais) if ais else 0

    print("\n" + "=" * 72)
    print(f"OVERALL   videos={n} (real={len(reals)} ai={len(ais)})   "
          f"accuracy={overall*100:.1f}%")
    print(f"          FPR (real called AI) = {fpr*100:.1f}%   "
          f"miss (AI called real) = {miss*100:.1f}%")
    if skipped:
        print(f"          {skipped} unlabelled skipped, {failed} failed to decode")

    weak_slices = []
    for dim in ("orientation", "lighting", "resolution", "family"):
        print("\n" + "=" * 72)
        print(f"BY {dim.upper()}")
        print(f"  {'value':<24}{'n':>5}{'acc':>7}{'FPR':>7}{'miss':>7}"
              f"{'real':>6}{'ai':>5}")
        for s in slice_report(rows, dim, args.min_n):
            flag = ""
            if s["n"] >= args.min_n and s["acc"] < overall - 0.10:
                flag = "  <-- WEAK"
                weak_slices.append((dim, s))
            print(f"  {s['value'][:23]:<24}{s['n']:>5}{fmt(s['acc']):>7}"
                  f"{fmt(s['fpr']):>7}{fmt(s['miss']):>7}"
                  f"{s['n_real']:>6}{s['n_ai']:>5}{flag}")

    # ---- prioritised recommendation ----
    print("\n" + "=" * 72)
    print("WHAT TO COLLECT MORE OF  (weakest slices with enough samples first)")
    print("=" * 72)
    if not weak_slices:
        print("  No slice is >10 points below overall accuracy -- the model is")
        print("  balanced across these conditions. Gains now need MORE GENERATORS")
        print("  or a model change, not more of one condition.")
    else:
        weak_slices.sort(key=lambda t: t[1]["acc"])
        for dim, s in weak_slices:
            side = ("REAL videos" if (s["fpr"] or 0) >= (s["miss"] or 0) else "AI videos")
            print(f"  * {dim}={s['value']}: only {s['acc']*100:.0f}% accurate "
                  f"on {s['n']} clips -> collect more {side} of this kind")
    print(f"\nper-video detail -> {out_csv.resolve()}")


if __name__ == "__main__":
    main()
