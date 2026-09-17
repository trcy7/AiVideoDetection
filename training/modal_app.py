"""Modal deployment of the ECNet inference API (src/server.py, unchanged).

Run every command from training/:

    pip install modal && modal setup
    modal volume create ecnet-models
    modal volume put ecnet-models models/ECNet-7.pt ECNet-7.pt
    modal deploy modal_app.py          # prints the public https URL

Then point the frontend at that URL via VITE_BACKEND_URL, and add the
frontend's origin to ALLOWED_ORIGINS below so CORS lets it through.

The 435 MB checkpoint lives in a Volume rather than the image, so redeploys
push only code -- the weights upload once.
"""

from __future__ import annotations

import modal

# Origins allowed to call this API. The deployed frontend MUST be listed here
# (comma-separate several); localhost is already allowed by a regex in server.py.
# Still the repo-wide placeholder -- swap it with index.html/sitemap.xml at launch.
ALLOWED_ORIGINS = "https://ai-video-detection-five.vercel.app/"

CHECKPOINT = "ECNet-7.pt"        # filename inside the ecnet-models volume
MODELS_DIR = "/models"
DATA_DIR = "/data"

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")       # _normalize_upload tonemaps HDR uploads to SDR
    .pip_install_from_requirements("requirements-serve.txt")
    .add_local_python_source("src")
)

# Weights and the audit trail are separate so redeploying code never risks either.
models = modal.Volume.from_name("ecnet-models", create_if_missing=True)
data = modal.Volume.from_name("ecnet-data", create_if_missing=True)

app = modal.App("ecnet")


@app.cls(
    image=image,
    gpu="T4",
    volumes={MODELS_DIR: models, DATA_DIR: data},
    secrets=[modal.Secret.from_dict({"ECNET_ALLOWED_ORIGINS": ALLOWED_ORIGINS})],
    # The audit trail is SQLite on a Volume, which tolerates exactly one writer.
    # Lifting this cap means moving db.py off SQLite first.
    max_containers=1,
    # Keep the model resident between uploads; a cold start reloads ~435 MB.
    # Set min_containers=1 to pay for an always-warm container instead.
    scaledown_window=300,
    timeout=900,
)
# Cheap GETs (/health, /stats) shouldn't queue behind a running analysis.
@modal.concurrent(max_inputs=4)
class Server:
    @modal.enter()
    def start(self) -> None:
        from src.server import init_server

        init_server(f"{MODELS_DIR}/{CHECKPOINT}", db_path=f"{DATA_DIR}/ecnet.db")

    @modal.asgi_app()
    def api(self):
        from src.server import app as web_app

        @web_app.middleware("http")
        async def persist_writes(request, call_next):
            """Flush /analyze and /feedback rows to the Volume immediately --
            background commits would otherwise lose the last few seconds.
            .aio so the commit RPC doesn't block the event loop."""
            response = await call_next(request)
            if request.method == "POST":
                await data.commit.aio()
            return response

        return web_app
