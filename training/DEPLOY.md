# Deploying the ECNet backend

Three ways to ship the same API ([`src/server.py`](src/server.py), unchanged in all):

| | Cost | GPU | Stays up | Use when |
| --- | --- | --- | --- | --- |
| **Kaggle + ngrok** | free | T4 | while the session lives | demo on free GPU — **current setup** |
| **Modal** | pay-per-second | T4 | always (scales to zero) | hands-off hosting |
| **Docker** | host-dependent | optional | always | Fly/Render/Railway/Cloud Run |

All three share [`requirements-serve.txt`](requirements-serve.txt) and the same
env vars (`ECNET_HOST`, `PORT`, `ECNET_ALLOWED_ORIGINS`). Modal and Kaggle build
their own environments, so neither uses the Dockerfile.

Run every command below from `training/`.

---

# Path A — Kaggle GPU behind a static ngrok domain

Free T4, and the public URL never changes even though Kaggle sessions die. That
last part is the whole point: with a **reserved** ngrok domain the frontend is
built once and never touched again — session dies, rerun the notebook, same URL.

Everything runs from [`notebooks/kaggle_serve_ngrok.ipynb`](notebooks/kaggle_serve_ngrok.ipynb),
which is a thin wrapper over [`kaggle_serve.py`](kaggle_serve.py).

## One-time setup

1. **Find your domain** — [dashboard.ngrok.com](https://dashboard.ngrok.com) →
   *Gateway → Domains*. Every account is auto-assigned one dev domain, free and
   permanent, looking like `cheerful-mantis-42.ngrok-free.dev`. You cannot choose the name on the
   free plan — that's a paid feature — but you don't need to: it never changes,
   which is the only property this setup depends on.
2. **Upload the weights** as a private Kaggle Dataset (`models/ECNet-7.pt`, 435 MB).
3. **Add Kaggle Secrets** (*Add-ons → Secrets*) — never paste these into a cell,
   notebooks get shared:
   - `NGROK_AUTHTOKEN`
   - `NGROK_DOMAIN` (e.g. `cheerful-mantis-42.ngrok-free.dev`)
4. In the notebook, set `ALLOWED_ORIGINS` to your deployed frontend origin.

## Every run

Open the notebook → Accelerator **GPU T4 x2**, Internet **On** → attach the
weights dataset → **Run All** → leave the last cell running. It prints:

```
  LIVE: https://cheerful-mantis-42.ngrok-free.dev
```

The notebook verifies the *public* URL returns JSON before declaring success, so
a green run means the frontend can actually reach it.

## Wire the frontend (once, forever)

```
VITE_USE_REAL_BACKEND=true
VITE_BACKEND_URL=https://cheerful-mantis-42.ngrok-free.dev
```

Set these in Vercel and redeploy **once**. Because the domain is reserved, no
future session requires touching this again.

## The interstitial trap

ngrok's free tier answers browser-shaped requests with an HTML warning page
instead of your response, and that page carries **no CORS headers** — so the
frontend sees an opaque network error, not a readable one. Every request from
[`realBackend.ts`](../src/utils/realBackend.ts) therefore sends
`ngrok-skip-browser-warning: true`. If you ever write a new client against this
backend, it needs that header too.

## Known limits

- **Audit trail is ephemeral.** `/kaggle/working/ecnet.db` dies with the session.
  *Save Version* snapshots `/kaggle/working` if you want to keep verdict history
  and user feedback.
- **Quota.** ~30 GPU-hours/week, 12 h per session.
- **Bandwidth.** ngrok free meters transfer and uploaded clips dominate it —
  fine for a demo audience, not for a launch.
- **One agent at a time** on the free tier; `kaggle_serve.py` kills stale tunnels
  before connecting, so a crashed session doesn't lock you out.

---

# Path B — Modal

## One-time setup

```bash
pip install modal
modal setup                                          # opens a browser to link your account

modal volume create ecnet-models
modal volume put ecnet-models models/ECNet-7.pt ECNet-7.pt   # ~435 MB, uploads once
```

The checkpoint is git-ignored and deliberately **not** baked into the image —
it lives in the `ecnet-models` volume, so redeploys push code only.

## Deploy

Set `ALLOWED_ORIGINS` at the top of `modal_app.py` to your deployed frontend
origin first (it is still the repo-wide `https://ai-video-detection-five.vercel.app` placeholder),
then:

```bash
modal deploy modal_app.py
```

Modal prints the public URL, e.g. `https://<workspace>--ecnet-server-api.modal.run`.
Verify it:

```bash
curl https://<your-url>/health
```

Expect `{"status":"ok","checkpoint":"/models/ECNet-7.pt","bands":{...},"storage":true}`.

## Wire up the frontend

Set these in the Vercel project (Settings → Environment Variables), then redeploy:

```
VITE_USE_REAL_BACKEND=true
VITE_BACKEND_URL=https://<your-url>
```

`VITE_*` vars are baked in at build time, so a redeploy is required — changing
them without rebuilding has no effect.

## Iterating

```bash
modal serve modal_app.py     # hot-reloading dev URL, no deploy
modal app logs ecnet         # live logs
modal volume ls ecnet-data   # the SQLite audit trail
```

Swapping in a newer checkpoint:

```bash
modal volume put ecnet-models models/ECNet-8.pt ECNet-8.pt
# set CHECKPOINT = "ECNet-8.pt" in modal_app.py, then redeploy
```

`modelVersion` in every response follows the filename, so the UI label tracks
this automatically.

## What the config does

| Setting | Why |
| --- | --- |
| `gpu="T4"` | Keeps the default 48-window whole-clip coverage viable. On CPU it is far too slow — that is what `--max-score-windows` exists for. |
| `scaledown_window=300` | Container stays warm 5 min after the last request. Idle time is not billed once it scales to zero. |
| `max_containers=1` | The audit trail is SQLite on a volume, which tolerates one writer. Raising this requires moving `db.py` off SQLite first. |
| `@modal.concurrent(max_inputs=4)` | `/health` and `/stats` don't queue behind a running analysis. |
| `timeout=900` | Ceiling for one long upload + analysis. |
| `apt_install("ffmpeg")` | `_normalize_upload` tonemaps HDR (PQ/HLG) uploads to SDR; without it they pass through untonemapped. |

**Cold starts.** Scaled to zero, the first request pays a container start plus a
~435 MB checkpoint load. Set `min_containers=1` for an always-warm container if
that matters more than the idle cost.

**Volumes.** `ecnet-models` holds weights, `ecnet-data` the audit trail, so
redeploying code never risks either. A middleware in `modal_app.py` commits
`ecnet-data` after every POST rather than relying on background commits.

# Path C — Docker

```bash
docker build -t ecnet .                    # add --build-arg TORCH_INDEX=.../cu121 for GPU
docker run -p 8000:8000 \
  -e ECNET_ALLOWED_ORIGINS=https://ai-video-detection-five.vercel.app \
  -e ECNET_CHECKPOINT_URL=https://<direct-link-to>/ECNet-7.pt \
  -v ecnet-data:/data -v ecnet-models:/models \
  ecnet --max-score-windows 12 --max-cam-windows 4
```

The window caps matter on CPU-only hosts — the default 48 is far too slow there.
Everything after the image name is passed through to `src/server.py`.

---

## Dependencies

`requirements-serve.txt` is the serving set — no albumentations, pandas,
scikit-learn or matplotlib, since the inference path no longer imports
`src.dataset`. Use the full `requirements.txt` for training.
