"""Serve the ECNet API from a Kaggle GPU session over a STATIC ngrok domain.

Why this exists: Kaggle gives a free T4, but sessions are mortal -- a 12 h cap,
an idle timeout, and a weekly GPU quota. A *reserved* ngrok domain makes the
public URL survive that, so the deployed frontend is built once and never
touched again. Session dies -> rerun the notebook -> same URL, back online.

Usage (from training/, inside the notebook):

    import kaggle_serve
    kaggle_serve.serve(checkpoint="/kaggle/input/ecnet-weights/ECNet-7.pt")

Needs two Kaggle Secrets (Add-ons -> Secrets):
    NGROK_AUTHTOKEN   your ngrok auth token
    NGROK_DOMAIN      your reserved domain, e.g. cheerful-mantis-42.ngrok-free.dev
"""

from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path
from typing import Optional

DEFAULT_PORT = 8000
# Must match the deployed frontend exactly (scheme + host, no trailing slash).
DEFAULT_ORIGINS = "https://ecnet.example.com"


def _secret(name: str, default: Optional[str] = None) -> Optional[str]:
    """Kaggle Secrets first, then env. Kept out of the notebook so no token
    is ever pasted into a cell (notebooks get committed and shared)."""
    try:
        from kaggle_secrets import UserSecretsClient

        return UserSecretsClient().get_secret(name)
    except Exception:
        return os.getenv(name, default)


def find_checkpoint(explicit: Optional[str] = None) -> Path:
    """Locate the .pt: an explicit path, else the only one under /kaggle/input."""
    if explicit:
        p = Path(explicit)
        if not p.exists():
            raise FileNotFoundError(f"Checkpoint not found: {p}")
        return p

    found = sorted(Path("/kaggle/input").rglob("*.pt")) if Path("/kaggle/input").exists() else []
    if not found:
        raise FileNotFoundError(
            "No .pt under /kaggle/input. Attach the weights dataset to this "
            "notebook (Add Input), or pass checkpoint=... explicitly."
        )
    if len(found) > 1:
        raise ValueError(f"Several checkpoints found, pass one explicitly: {found}")
    return found[0]


def open_tunnel(port: int = DEFAULT_PORT) -> str:
    """Bind the reserved domain to `port`. Returns the public URL.

    Without domain= ngrok hands out a random URL each run, which is exactly the
    redeploy treadmill this setup exists to avoid -- so a missing NGROK_DOMAIN
    is a hard error, not a silent fallback.
    """
    # Secrets are validated BEFORE importing pyngrok, so a misconfigured
    # notebook reports the actual problem instead of an import error.
    token = _secret("NGROK_AUTHTOKEN")
    domain = _secret("NGROK_DOMAIN")
    if not token:
        raise RuntimeError("NGROK_AUTHTOKEN missing -- add it under Add-ons -> Secrets.")
    if not domain:
        raise RuntimeError(
            "NGROK_DOMAIN missing. Reserve your free static domain at "
            "dashboard.ngrok.com -> Domains, then add it as a Kaggle Secret."
        )

    domain = domain.replace("https://", "").replace("http://", "").rstrip("/")

    from pyngrok import conf, ngrok

    conf.get_default().auth_token = token

    # A dead Kaggle session can leave its agent registered; free tier allows one.
    try:
        ngrok.kill()
    except Exception:
        pass

    tunnel = ngrok.connect(port, "http", domain=domain)
    return tunnel.public_url


def _wait_for_local(port: int, timeout: float = 300.0) -> None:
    """Block until the model has finished loading and /health answers."""
    import urllib.request

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5) as r:
                if r.status == 200:
                    return
        except Exception:
            time.sleep(2)
    raise TimeoutError(f"Server did not become healthy within {timeout:.0f}s")


def _verify_public(url: str) -> None:
    """Prove the *public* path returns JSON, not ngrok's HTML interstitial.

    The free tier serves that interstitial to anything it thinks is a browser,
    and it arrives without CORS headers -- so the frontend sees an opaque
    network failure. The skip header is what the frontend sends too.
    """
    import json
    import urllib.request

    req = urllib.request.Request(
        f"{url}/health", headers={"ngrok-skip-browser-warning": "true"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read().decode()
    payload = json.loads(body)  # raises if the interstitial came back instead
    if payload.get("bands") is None:
        raise RuntimeError(f"Server up but no model loaded: {payload}")
    print(f"   verified through ngrok: {payload}")


def serve(
    checkpoint: Optional[str] = None,
    *,
    port: int = DEFAULT_PORT,
    allowed_origins: Optional[str] = None,
    db_path: str = "/kaggle/working/ecnet.db",
    max_score_windows: Optional[int] = None,
    max_cam_windows: Optional[int] = None,
) -> None:
    """Load the model, expose it on the reserved domain, then block.

    Blocking is deliberate: the running cell is what keeps the Kaggle session
    from idling out. Interrupt the cell to shut down.
    """
    ckpt = find_checkpoint(checkpoint)

    # server.py reads this at IMPORT time, so it must be set before the import.
    os.environ["ECNET_ALLOWED_ORIGINS"] = allowed_origins or _secret(
        "ECNET_ALLOWED_ORIGINS", DEFAULT_ORIGINS
    )
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from src.server import app, init_server

    print(f"1/4 loading {ckpt.name} ...")
    init_server(
        str(ckpt),
        db_path=db_path,
        max_score_windows=max_score_windows,
        max_cam_windows=max_cam_windows,
    )

    import uvicorn

    print("2/4 starting uvicorn ...")
    server = uvicorn.Server(uvicorn.Config(app, host="0.0.0.0", port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    _wait_for_local(port)

    print("3/4 opening tunnel ...")
    url = open_tunnel(port)

    print("4/4 verifying public URL ...")
    _verify_public(url)

    print(f"\n{'=' * 62}\n  LIVE: {url}\n  CORS: {os.environ['ECNET_ALLOWED_ORIGINS']}"
          f"\n  Audit trail: {db_path} (lost when the session ends)"
          f"\n{'=' * 62}\n  Leave this cell running. Interrupt it to stop.\n")

    started = time.time()
    try:
        while True:
            time.sleep(600)
            print(f"  alive {(time.time() - started) / 3600:.1f}h -- {url}", flush=True)
    except KeyboardInterrupt:
        print("shutting down")
        from pyngrok import ngrok

        ngrok.kill()
