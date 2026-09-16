# Deploying ECNet

Two deployments, not three. The model is a **file the backend loads**, not a service.

```
Frontend (Vercel, static)  --HTTPS-->  Backend (one GPU host)
                                        server.py + ECNet-7.pt in memory
                                        + data/ecnet.db (SQLite)
```

---

## 1. Get the checkpoint to the host

`ECNet-7.pt` is 416 MB and gitignored, so it is **not** in the image. Pick one:

| Option | How |
|---|---|
| **Volume** (best for a persistent pod) | Copy the file to the host, mount it at `/models` |
| **Download on boot** | Upload it somewhere public, set `ECNET_CHECKPOINT_URL` |
| **Bake into image** | Remove `models/` from `.dockerignore` and `COPY` it (~2.5 GB image) |

Hugging Face Hub is a good home for the weights:
`huggingface-cli upload <user>/ecnet ECNet-7.pt`, then use the resolve URL.

---

## 2. Build

```bash
cd training
docker build -t ecnet .                                                   # CPU
docker build -t ecnet --build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu121 .   # GPU
```

## 3. Run

```bash
docker run -d --gpus all -p 8000:8000 \
  -v /path/to/models:/models \
  -v /path/to/data:/data \
  -e ECNET_ALLOWED_ORIGINS="https://YOUR-SITE.vercel.app" \
  ecnet
```

Without a GPU, cut the cost so requests do not time out:

```bash
docker run -d -p 8000:8000 -v /path/to/models:/models -v /path/to/data:/data \
  -e ECNET_ALLOWED_ORIGINS="https://YOUR-SITE.vercel.app" \
  ecnet --db /data/ecnet.db --max-score-windows 12 --max-cam-windows 3
```

### Environment variables

| Variable | Purpose |
|---|---|
| `ECNET_ALLOWED_ORIGINS` | **Required in production.** Comma-separated frontend origins. Unset = every non-localhost origin is blocked. |
| `ECNET_CHECKPOINT` | Checkpoint path (default `/models/ECNet-7.pt`) |
| `ECNET_CHECKPOINT_URL` | Downloaded on first boot when the file is absent |
| `PORT` | Injected by most PaaS; defaults to 8000 |
| `ECNET_HOST` | Already `0.0.0.0` in the image |

### Flags

`--max-score-windows N` clip coverage (default 48) · `--max-cam-windows N` GradCAM cost (default 8, the dominant cost) · `--fake-above` / `--real-below` retune verdict bands · `--no-db` disable storage

---

## 4. Host notes

**RunPod (GPU pod)** — start a PyTorch pod, expose 8000, put the checkpoint on the
persistent volume. No cold start while running; SQLite works on local disk. Stop it
when you are not demoing.

**Hugging Face Spaces (Docker)** — set `app_port: 8000` in the Space README, and put
the weights in an HF model repo referenced via `ECNET_CHECKPOINT_URL`. Free tier is
CPU-only, so pass the reduced-window flags.

**Serverless (Modal etc.)** — loading a 416 MB checkpoint dominates cold start, and
SQLite needs a Volume. Workable, but a pod is simpler for a demo.

---

## 5. Connect the frontend

On Vercel -> Settings -> Environment Variables:

```
VITE_USE_REAL_BACKEND=true
VITE_BACKEND_URL=https://your-backend-url
```

**Redeploy afterwards** — Vite inlines these at build time, so a restart is not enough.
The backend must be **HTTPS**, or the browser blocks it as mixed content.

## 6. Verify

```bash
curl https://your-backend-url/health     # {"status":"ok", "storage":true, "bands":{...}}
curl https://your-backend-url/stats      # audit trail + feedback accuracy
```

In the UI the analyze section should read *"Drop a clip - ECNet scores it frame by
frame..."*. If it still says *"Sample results run entirely in your browser"*, the env
vars did not reach the build -- you are in mock mode and results are random.
