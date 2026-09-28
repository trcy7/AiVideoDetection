"""Write a serving-only copy of a checkpoint: weights + config, nothing else.

    python strip_checkpoint.py models/ECNet-7.pt

A training checkpoint carries the optimizer's two moment tensors per parameter
plus scheduler and AMP scaler state, so the file is roughly three times the
weights. Inference reads none of it. Dropping it takes ECNet-7 from 436 MB to
149 MB, which is what every server start has to pull off disk -- on Kaggle that
is a network-backed mount, so it is the difference worth having.

Keep the full checkpoint: resuming training needs the optimizer state, and this
copy cannot be resumed from.
"""

from __future__ import annotations

import argparse
from pathlib import Path

KEEP = ("model", "config")          # everything inference.py ever reads


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("checkpoint")
    ap.add_argument("--out", default=None,
                    help="output path (default: <name>-serve.pt beside the input)")
    args = ap.parse_args()

    import torch

    src = Path(args.checkpoint)
    if not src.exists():
        raise SystemExit(f"NOT FOUND: {src}")
    dst = Path(args.out) if args.out else src.with_name(f"{src.stem}-serve.pt")

    ck = torch.load(src, map_location="cpu", weights_only=False)
    missing = [k for k in KEEP if k not in ck]
    if missing:
        raise SystemExit(f"checkpoint is missing {missing}; refusing to write a broken copy")

    dropped = sorted(k for k in ck if k not in KEEP)
    torch.save({k: ck[k] for k in KEEP}, dst)

    before, after = src.stat().st_size, dst.stat().st_size
    print(f"kept    : {', '.join(KEEP)}")
    print(f"dropped : {', '.join(dropped) or '(nothing)'}")
    print(f"{before / 1e6:.0f} MB -> {after / 1e6:.0f} MB  ({(1 - after / before) * 100:.0f}% smaller)")
    print(f"\nwrote {dst}")
    print("Upload this as the Kaggle weights dataset; keep the original for resuming training.")


if __name__ == "__main__":
    main()
