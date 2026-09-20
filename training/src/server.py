"""Local inference API for the ECNet frontend (FastAPI, CORS for localhost).

Run: python -m src.server --checkpoint models/ECNet-7.pt
Frontend .env.local: VITE_USE_REAL_BACKEND=true, VITE_BACKEND_URL=http://localhost:8000
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import os
import shutil
import socket
import tempfile
import time
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import db
from .inference import Predictor

app = FastAPI(title="ECNet local inference server")

# Dev: any localhost port (Vite may pick 5173+). Production: set
# ECNET_ALLOWED_ORIGINS to a comma-separated list of deployed frontend origins,
# e.g. ECNET_ALLOWED_ORIGINS="https://ai-video-detection-five.vercel.app" (comma-separate several)
_ALLOWED = [o.strip().rstrip("/") for o in
            os.getenv("ECNET_ALLOWED_ORIGINS", "").split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED,
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
    return {"status": "ok", "checkpoint": str(_state["checkpoint_path"]), "bands": bands,
            "storage": db.enabled()}


MAX_URL_SECONDS = 60          # only the first minute is fetched and scored
MAX_URL_BYTES = 200_000_000


def _analyze_path(path: Path, file_hash: str) -> dict:
    """Score one local file. Shared by /analyze and /analyze-url."""
    predictor: Optional[Predictor] = _state["predictor"]
    if predictor is None:
        raise HTTPException(500, "Server started without --checkpoint")

    analyze_path = _normalize_upload(path)       # HDR -> SDR when ffmpeg is present
    started = time.perf_counter()
    try:
        result = predictor.predict(analyze_path)  # resident model -> no per-request reload
    except ValueError as e:
        raise HTTPException(422, f"Could not analyze video: {e}")
    finally:
        if analyze_path != path:
            analyze_path.unlink(missing_ok=True)

    result["modelVersion"] = _state["model_version"]
    processing_ms = int((time.perf_counter() - started) * 1000)
    # audit trail; analysisId lets the client attach ground-truth feedback later
    result["analysisId"] = db.log_analysis(result, file_hash, processing_ms)
    return result


def _reject_internal_host(url: str) -> None:
    """The server fetches whatever the client pastes, so refuse anything that
    resolves inside the network -- otherwise this is an SSRF hole into the
    host's own metadata and admin endpoints."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(422, "Only http(s) links are supported")
    try:
        infos = socket.getaddrinfo(parsed.hostname, None)
    except OSError:
        raise HTTPException(422, f"Could not resolve {parsed.hostname}")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise HTTPException(422, "That host is not publicly routable")


def _download_clip(url: str) -> tuple[Path, Path, str, bool]:
    """Fetch the first MAX_URL_SECONDS of a public video link via yt-dlp.
    Returns (tempdir, file, title) -- the caller removes the tempdir."""
    try:
        import yt_dlp
    except ImportError:
        raise HTTPException(503, "Link analysis is unavailable (yt-dlp not installed)")

    _reject_internal_host(url)
    tmpdir = Path(tempfile.mkdtemp(prefix="ecnet_url_"))
    opts = {
        # Video-only by preference: the model never looks at audio, so this
        # avoids a merge step and halves the download. YouTube serves DASH
        # streams, where a COMBINED mp4 above 360p often does not exist at all --
        # asking for one is what makes it fail with "format is not available".
        # Resolution capped because the model runs at 380px.
        "format": ("bv*[height<=720][ext=mp4]/bv*[height<=720]/bv*"
                   "/b[height<=720][ext=mp4]/b[height<=720]/b"),
        "outtmpl": str(tmpdir / "clip.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "max_filesize": MAX_URL_BYTES,
        "socket_timeout": 30,
    }
    # Section download is an ffmpeg feature. Without it we still cap bytes, but
    # the whole clip gets scored rather than just the first minute -- say so in
    # the response instead of pretending the limit held.
    trimmed = shutil.which("ffmpeg") is not None
    if trimmed:
        opts["download_ranges"] = yt_dlp.utils.download_range_func(
            None, [(0, MAX_URL_SECONDS)])
        opts["force_keyframes_at_cuts"] = True
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except Exception as e:
        shutil.rmtree(tmpdir, ignore_errors=True)
        # yt-dlp messages name the real cause (private, geo-blocked, login wall)
        raise HTTPException(422, f"Could not fetch that link: {str(e)[:200]}")

    files = [f for f in tmpdir.iterdir() if f.is_file() and f.stat().st_size > 10_000]
    if not files:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise HTTPException(422, "That link produced no downloadable video")
    title = (info or {}).get("title") or "link"
    return tmpdir, max(files, key=lambda f: f.stat().st_size), title, trimmed


class AnalyzeUrlIn(BaseModel):
    url: str


@app.post("/analyze-url")
def analyze_url(body: AnalyzeUrlIn) -> dict:
    """Analyze a public video link (YouTube/TikTok/Instagram/Facebook/direct).
    Only the first minute is fetched; the file is deleted after scoring."""
    tmpdir, path, title, trimmed = _download_clip(body.url.strip())
    try:
        file_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        result = _analyze_path(path, file_hash)
        result["fileName"] = f"{title[:80]}{path.suffix}"
        result["sourceUrl"] = body.url.strip()
        result["truncatedToSeconds"] = MAX_URL_SECONDS if trimmed else None
        return result
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)   # the download never persists


@app.post("/analyze")
async def analyze(video: UploadFile = File(...)) -> dict:
    raw = await video.read()
    # identify a repeat upload without ever storing the video itself
    file_hash = hashlib.sha256(raw).hexdigest()

    suffix = Path(video.filename or "upload.mp4").suffix or ".mp4"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(raw)
        tmp_path = Path(tmp.name)
    try:
        return _analyze_path(tmp_path, file_hash)
    finally:
        tmp_path.unlink(missing_ok=True)            # the upload never persists


class FeedbackIn(BaseModel):
    analysisId: str
    actualLabel: str          # "real" | "ai_generated" | "unsure"
    note: str | None = None


@app.post("/feedback")
def feedback(body: FeedbackIn) -> dict:
    """Ground truth for a past analysis -- builds a real-world labeled set."""
    if not db.enabled():
        raise HTTPException(503, "Feedback storage is disabled on this server")
    if body.actualLabel not in db.LABELS:
        raise HTTPException(422, f"actualLabel must be one of {db.LABELS}")
    if not db.save_feedback(body.analysisId, body.actualLabel, body.note):
        raise HTTPException(404, "Unknown analysisId")
    return {"status": "ok"}


@app.get("/stats")
def stats() -> dict:
    """Aggregate counts + accuracy measured against collected feedback."""
    return db.stats()


def init_server(
    checkpoint: str | Path,
    *,
    db_path: Optional[str] = "data/ecnet.db",
    real_below: Optional[float] = None,
    fake_above: Optional[float] = None,
    max_score_windows: Optional[int] = None,
    max_cam_windows: Optional[int] = None,
) -> None:
    """Load storage + the model into module state. Shared by the CLI and Modal.

    db_path=None runs with no audit trail / feedback.
    """
    if db_path:
        db.init(db_path)

    checkpoint_path = Path(checkpoint)
    if not checkpoint_path.exists():
        raise SystemExit(f"Checkpoint not found: {checkpoint_path}")

    _state["checkpoint_path"] = checkpoint_path
    _state["model_version"] = _model_version_label(checkpoint_path)
    # Load the model ONCE here so it stays resident for every request, instead
    # of reloading ~450 MB of weights on each /analyze. First analysis is warm.
    print(f"Loading checkpoint: {checkpoint_path} ...")
    predictor = Predictor(checkpoint_path)
    icfg = predictor.cfg["inference"]
    if real_below is not None:
        icfg["verdict_real_below"] = float(real_below)
    if fake_above is not None:
        icfg["verdict_fake_above"] = float(fake_above)
    if max_score_windows is not None:
        icfg["max_score_windows"] = max(1, int(max_score_windows))
    if max_cam_windows is not None:
        icfg["max_cam_windows"] = max(1, int(max_cam_windows))
    _state["predictor"] = predictor

    overridden = real_below is not None or fake_above is not None
    print(f"Model resident. Version label: {_state['model_version']}")
    print(f"Verdict bands: real < {icfg['verdict_real_below']} | uncertain | AI > {icfg['verdict_fake_above']}"
          + ("  (OVERRIDDEN via flags)" if overridden else "  (from checkpoint)"))
    print(f"Storage: {db_path}" if db.enabled() else "Storage: disabled (no audit trail / feedback)")
    print(f"Coverage: up to {icfg.get('max_score_windows', 48)} scoring windows, "
          f"GradCAM on {icfg.get('max_cam_windows', 8)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True)
    # In a container the bind MUST be 0.0.0.0 or nothing outside can reach it;
    # most PaaS also inject $PORT. Env-driven so Docker needs no custom CMD.
    parser.add_argument("--host", default=os.getenv("ECNET_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "8000")))
    # Live verdict-threshold overrides (0-100). When given, they OVERRIDE the
    # calibration baked into the checkpoint -- so you can re-point the "real"/"AI"
    # cutoffs without editing the .pt. Affects everything consistently: the
    # verdict, the returned bands, and the frontend gauge all use these.
    parser.add_argument("--real-below", type=float, default=None,
                        help="score below this = 'real' (overrides the checkpoint)")
    parser.add_argument("--fake-above", type=float, default=None,
                        help="score above this = 'AI' (overrides the checkpoint), e.g. 80")
    parser.add_argument("--db", default="data/ecnet.db",
                        help="SQLite file for the analysis audit trail + feedback")
    parser.add_argument("--no-db", action="store_true", help="run without any storage")
    # Inference cost knobs: fewer windows = faster, slightly less clip coverage.
    # Essential on CPU-only hosts, where the default 48 is far too slow.
    parser.add_argument("--max-score-windows", type=int, default=None,
                        help="windows tiling the clip for scoring (default 48)")
    parser.add_argument("--max-cam-windows", type=int, default=None,
                        help="windows given per-frame GradCAM (default 8)")
    args = parser.parse_args()

    init_server(
        args.checkpoint,
        db_path=None if args.no_db else args.db,
        real_below=args.real_below,
        fake_above=args.fake_above,
        max_score_windows=args.max_score_windows,
        max_cam_windows=args.max_cam_windows,
    )
    print(f"Serving on http://{args.host}:{args.port}")

    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
