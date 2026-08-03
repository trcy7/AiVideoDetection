"""Local inference API for the ECNet frontend (FastAPI, CORS for localhost).

Run: python -m src.server --checkpoint models/ECNet-7.pt
Frontend .env.local: VITE_USE_REAL_BACKEND=true, VITE_BACKEND_URL=http://localhost:8000
"""

from __future__ import annotations

import argparse
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .inference import Predictor

app = FastAPI(title="ECNet local inference server")

# allow any localhost port (Vite may pick 5173+); local-dev only
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

_state: dict = {"checkpoint_path": None, "model_version": "ECNet", "predictor": None}

_TONEMAP = ("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
            "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p")


def _normalize_upload(path: Path) -> Path:
    """Tonemap HDR (PQ/HLG) uploads to SDR via ffmpeg if available; else pass through."""
    import shutil as _sh
    import subprocess

    if _sh.which("ffmpeg") is None or _sh.which("ffprobe") is None:
        return path
    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=color_transfer", "-of", "default=nw=1:nk=1", str(path)],
            capture_output=True, text=True, timeout=30).stdout.lower()
        if not any(t in probe for t in ("smpte2084", "arib-std-b67")):
            return path  # SDR -> nothing to do
        dst = path.with_suffix(".sdr.mp4")
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", str(path), "-vf", _TONEMAP,
             "-c:v", "libx264", "-crf", "20", "-preset", "veryfast", "-an", str(dst)],
            check=True, timeout=600, capture_output=True)
        if dst.exists() and dst.stat().st_size > 10_000:
            return dst
    except Exception:
        pass
    return path


def _model_version_label(checkpoint_path: Path) -> str:
    """Frontend label: the checkpoint name (e.g. ECNet-7)."""
    return checkpoint_path.stem or "ECNet"


@app.get("/health")
def health() -> dict:
    pred = _state.get("predictor")
    bands = None
    if pred is not None:
        icfg = pred.cfg["inference"]
        bands = {"realBelow": icfg.get("verdict_real_below"), "fakeAbove": icfg.get("verdict_fake_above")}
    return {"status": "ok", "checkpoint": str(_state["checkpoint_path"]), "bands": bands}


@app.post("/analyze")
async def analyze(video: UploadFile = File(...)) -> dict:
    predictor: Optional[Predictor] = _state["predictor"]
    if predictor is None:
        raise HTTPException(500, "Server started without --checkpoint")

    suffix = Path(video.filename or "upload.mp4").suffix or ".mp4"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await video.read())
        tmp_path = Path(tmp.name)

    analyze_path = _normalize_upload(tmp_path)   # HDR -> SDR when ffmpeg is present
    try:
        result = predictor.predict(analyze_path)   # resident model -> no per-request reload
    except ValueError as e:
        raise HTTPException(422, f"Could not analyze video: {e}")
    finally:
        tmp_path.unlink(missing_ok=True)
        if analyze_path != tmp_path:
            analyze_path.unlink(missing_ok=True)

    result["modelVersion"] = _state["model_version"]
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    # Live verdict-threshold overrides (0-100). When given, they OVERRIDE the
    # calibration baked into the checkpoint -- so you can re-point the "real"/"AI"
    # cutoffs without editing the .pt. Affects everything consistently: the
    # verdict, the returned bands, and the frontend gauge all use these.
    parser.add_argument("--real-below", type=float, default=None,
                        help="score below this = 'real' (overrides the checkpoint)")
    parser.add_argument("--fake-above", type=float, default=None,
                        help="score above this = 'AI' (overrides the checkpoint), e.g. 80")
    args = parser.parse_args()

    checkpoint_path = Path(args.checkpoint)
    if not checkpoint_path.exists():
        raise SystemExit(f"Checkpoint not found: {checkpoint_path}")

    _state["checkpoint_path"] = checkpoint_path
    _state["model_version"] = _model_version_label(checkpoint_path)
    # Load the model ONCE here so it stays resident for every request, instead
    # of reloading ~450 MB of weights on each /analyze. First analysis is warm.
    print(f"Loading checkpoint: {checkpoint_path} ...")
    predictor = Predictor(checkpoint_path)
    icfg = predictor.cfg["inference"]
    if args.real_below is not None:
        icfg["verdict_real_below"] = float(args.real_below)
    if args.fake_above is not None:
        icfg["verdict_fake_above"] = float(args.fake_above)
    _state["predictor"] = predictor
    print(f"Model resident. Version label: {_state['model_version']}")
    print(f"Verdict bands: real < {icfg['verdict_real_below']} | uncertain | AI > {icfg['verdict_fake_above']}"
          + ("  (OVERRIDDEN via flags)" if (args.real_below is not None or args.fake_above is not None) else "  (from checkpoint)"))

    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
