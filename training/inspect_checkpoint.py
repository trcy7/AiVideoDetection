"""Audit a checkpoint the way a serving bug hunt needs it: is this REALLY the
best model, and did its VAL calibration travel with it?

The #1 cause of "great in eval, bad in the app" is a checkpoint mismatch:
  * last.pt got deployed instead of best.pt  -> a worse / overfit epoch, AND
  * last.pt has NO calibration written in it  -> inference silently falls back
    to the 35/65 defaults, so the app calls things "AI" far too aggressively.

Run (from training/, venv active):
    python inspect_checkpoint.py models/hybridmodel7.pt
"""

from __future__ import annotations

import argparse
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("checkpoint")
    args = ap.parse_args()

    import torch

    path = Path(args.checkpoint)
    if not path.exists():
        raise SystemExit(f"NOT FOUND: {path}")

    size_mb = path.stat().st_size / 1e6
    ckpt = torch.load(path, map_location="cpu", weights_only=False)
    print(f"file            : {path}  ({size_mb:.1f} MB)")

    if not isinstance(ckpt, dict) or "model" not in ckpt:
        raise SystemExit("This file is not a training checkpoint dict (no 'model' key). "
                         "Did Kaggle auto-extract the .pt into a folder? Re-zip it.")

    # --- which epoch / how good ------------------------------------------------
    epoch = ckpt.get("epoch", "?")
    best = ckpt.get("best_metric", None)
    phase = ckpt.get("phase", "?")
    print(f"epoch saved     : {epoch}   phase: {phase}")
    print(f"best_metric     : {best}   (the val video AUC this checkpoint claims)")
    hist = ckpt.get("history", [])
    if hist:
        last = hist[-1]
        print(f"last history row: {last}")

    # --- config that DRIVES inference -----------------------------------------
    cfg = ckpt.get("config", {})
    mcfg = cfg.get("model", {})
    ecfg = cfg.get("extraction", {})
    icfg = cfg.get("inference", {})
    print("\n--- model ---")
    print(f"  arch            : {mcfg.get('arch')}")
    print(f"  backbone        : {mcfg.get('backbone')}")
    print("\n--- preprocessing (MUST match training/extraction) ---")
    print(f"  image_size      : {ecfg.get('image_size')}")
    print(f"  window_len      : {ecfg.get('window_len')}")
    print(f"  target_fps      : {ecfg.get('target_fps')}")
    print(f"  trim_black_borders: {ecfg.get('trim_black_borders')}")

    # --- the calibration: the make-or-break for verdict quality ---------------
    print("\n--- calibration (verdict thresholds the app will draw) ---")
    rb = icfg.get("verdict_real_below")
    fa = icfg.get("verdict_fake_above")
    t_star = icfg.get("decision_threshold")
    calib = icfg.get("calibration")
    print(f"  verdict_real_below: {rb}")
    print(f"  verdict_fake_above: {fa}")
    print(f"  decision_threshold: {t_star}")
    print(f"  tta             : {icfg.get('tta', '(unset -> inference default)')}")
    print(f"  calibration meta: {calib}")

    print("\n=== VERDICT ON THIS CHECKPOINT ===")
    problems = []
    if calib is None or rb in (None, 35) and fa in (None, 65):
        problems.append(
            "NO CALIBRATION baked in (bands are the 35/65 fallback). You almost "
            "certainly deployed last.pt, not best.pt. The app will over-call 'AI'. "
            "Re-copy best.pt from the SAME run as your reported metrics.")
    if best is not None and isinstance(best, (int, float)) and best < 0.90:
        problems.append(
            f"best_metric {best:.4f} is BELOW your reported 0.9335 -- this is not "
            "the epoch-07 checkpoint. Wrong run's best.pt.")
    if str(mcfg.get("arch")) != "hybrid":
        problems.append(f"arch is '{mcfg.get('arch')}', expected 'hybrid'.")
    if ecfg.get("image_size") not in (380, "380"):
        problems.append(f"image_size {ecfg.get('image_size')} != 380 (preprocessing skew).")

    if problems:
        for p in problems:
            print("  [PROBLEM] " + p)
    else:
        print("  OK: hybrid, image_size 380, calibrated bands present, best_metric healthy.")
        print(f"  This checkpoint should verdict: real < {rb} | uncertain | AI > {fa}")


if __name__ == "__main__":
    main()
