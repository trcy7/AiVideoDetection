
from __future__ import annotations

import argparse
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("checkpoint")
    ap.add_argument("--real-below", type=float, default=None,
                    help="score below this = 'real' (0-100)")
    ap.add_argument("--fake-above", type=float, default=None,
                    help="score above this = 'AI' (0-100); lower = catches more AI")
    ap.add_argument("--from-tstar", action="store_true",
                    help="set both bands tight around the stored decision threshold t*")
    ap.add_argument("--out", default=None, help="output path (default: <name>_decisive.pt)")
    ap.add_argument("--show", action="store_true", help="print current bands and exit")
    args = ap.parse_args()

    import torch

    path = Path(args.checkpoint)
    if not path.exists():
        raise SystemExit(f"NOT FOUND: {path}")
    ckpt = torch.load(path, map_location="cpu", weights_only=False)
    icfg = ckpt["config"]["inference"]

    cur_rb = icfg.get("verdict_real_below", 35)
    cur_fa = icfg.get("verdict_fake_above", 65)
    t_star = float(icfg.get("decision_threshold", 0.5)) * 100.0
    print(f"current bands : real < {cur_rb}  |  uncertain  |  fake > {cur_fa}")
    print(f"model's t*    : {t_star:.1f}  (its own optimal 2-way cutoff, 0-100)")
    if args.show:
        return

    new_rb, new_fa = cur_rb, cur_fa
    if args.from_tstar:
        # A narrow uncertain zone hugging t*: decisive, still leaves a thin
        # "unsure" strip right at the boundary where the model is genuinely torn.
        new_rb = round(max(0.0, t_star - 8.0), 1)
        new_fa = round(min(100.0, t_star + 2.0), 1)
    if args.real_below is not None:
        new_rb = args.real_below
    if args.fake_above is not None:
        new_fa = args.fake_above

    if not (0 <= new_rb < new_fa <= 100):
        raise SystemExit(f"invalid bands: need 0 <= real_below ({new_rb}) < fake_above ({new_fa}) <= 100")

    icfg["verdict_real_below"] = float(new_rb)
    icfg["verdict_fake_above"] = float(new_fa)
    icfg.setdefault("calibration", {})["retuned"] = {
        "from": [cur_rb, cur_fa], "to": [new_rb, new_fa],
        "note": "operating point moved by retune_bands.py; ranking/AUC unchanged",
    }

    out = Path(args.out) if args.out else path.with_name(path.stem + "_decisive.pt")
    torch.save(ckpt, out)
    print(f"\nnew bands     : real < {new_rb}  |  uncertain  |  fake > {new_fa}")
    print(f"wrote         : {out}")
    print(f"\nrun it:  serve {out}")
    print("NOTE: this only moves the verdict line. It does NOT make the model")
    print("      smarter -- AUC is identical. It trades false-positives for recall.")


if __name__ == "__main__":
    main()
