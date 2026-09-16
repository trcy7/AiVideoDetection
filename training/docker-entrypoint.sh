#!/usr/bin/env bash
set -euo pipefail

CKPT="${ECNET_CHECKPOINT:-/models/ECNet-7.pt}"

# The 416 MB checkpoint is gitignored and not baked into the image. Fetch it on
# first boot when a URL is supplied (HF Hub, S3/R2, any direct link).
if [ ! -f "$CKPT" ]; then
  if [ -n "${ECNET_CHECKPOINT_URL:-}" ]; then
    echo "Downloading checkpoint -> $CKPT"
    mkdir -p "$(dirname "$CKPT")"
    curl -fsSL --retry 3 -o "$CKPT" "$ECNET_CHECKPOINT_URL"
  else
    echo "ERROR: no checkpoint at $CKPT and ECNET_CHECKPOINT_URL is unset." >&2
    echo "Mount a volume containing it, or set ECNET_CHECKPOINT_URL." >&2
    exit 1
  fi
fi

exec python -m src.server --checkpoint "$CKPT" "$@"
