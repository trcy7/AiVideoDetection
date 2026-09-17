# ECNet — AI Video Detection System: Local Setup Manual

Setup and reference for running the system on a local machine. Values below are taken directly from the project configuration.

---

## 1. Software to Install

- **Operating System:** Windows 10/11, macOS, or Linux
- **Python:** 3.10 or newer (developed on 3.10.11)
- **Git:** latest
- **Visual Studio Code:** latest
- **Node.js:** 20+ (developed on v24.18.0)
- **npm:** 10+ (developed on 11.16.0) — bundled with Node.js
- **NVIDIA GPU + CUDA:** optional; CPU works but inference is slower

---

## 2. VS Code Extensions

- **Python** (`ms-python.python`)
- **Pylance** (`ms-python.vscode-pylance`)
- **ESLint** (`dbaeumer.vscode-eslint`)
- **oxc** (`oxc.oxc-vscode`) — for the `oxlint` linter used by the frontend
- **Tailwind/CSS support is not required** (plain CSS is used)

---

## 3. Frontend Tech Stack

- **Framework:** React 19 + Vite 8 (TypeScript)
- **Routing:** react-router-dom 7
- **Libraries / dependencies (from `package.json`):**
  - `react@^19.2.7`
  - `react-dom@^19.2.7`
  - `react-router-dom@^7.18.1`
- **Dev dependencies:**
  - `vite@^8.1.1`
  - `@vitejs/plugin-react@^6.0.3`
  - `typescript@~6.0.2`
  - `oxlint@^1.71.0`
  - `@types/node@^24.13.2`, `@types/react@^19.2.17`, `@types/react-dom@^19.2.3`
- **Install all packages (from the project root):**
  ```
  npm install
  ```

---

## 4. Backend Tech Stack

- **Framework:** FastAPI (local inference server) + Uvicorn (ASGI server)
- **Python libraries (from `training/requirements.txt`):**
  - `fastapi==0.115.6`
  - `uvicorn[standard]==0.34.0`
  - `python-multipart==0.0.20`
- **Install (from `training/`, virtual environment active):**
  ```
  pip install -r requirements.txt
  ```

---

## 5. AI / Machine Learning Stack

All from `training/requirements.txt`:

- `torch>=2.2` (PyTorch)
- `torchvision>=0.17`
- `timm==1.0.11` (EfficientNet backbone)
- `opencv-python==4.10.0.84` (video/frame decoding)
- `numpy>=1.26`
- `pandas==2.2.3`
- `scikit-learn==1.5.2` (metrics: AUC, precision/recall, confusion matrix)
- `albumentations==1.4.18` (augmentation)
- `PyYAML==6.0.2` (config files)
- `tqdm==4.66.5` (progress bars)
- `matplotlib==3.9.2` (training curves)
- `decord==0.6.0` — **optional**, faster video decoding; the pipeline falls back to OpenCV if absent

**GPU (optional) — install CUDA build of torch instead of the default:**
```
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
```

---

## 6. Project Architecture

- **Frontend:** React SPA (Vite). Uploads a video, shows the verdict gauge, heatmap, branch scores, and history.
- **Backend:** FastAPI server (`training/src/server.py`) that loads a trained checkpoint and exposes an HTTP endpoint.
- **AI Model:** PyTorch hybrid model loaded by the backend from `best.pt`.
- **API communication:** Frontend `POST`s the video file (multipart/form-data) to `http://localhost:8000/analyze`; backend returns JSON.
- **Model inference flow:** upload → decode frames → resize-square preprocessing → hybrid model forward pass → fused probability → verdict + branch scores + heatmap boxes → JSON to frontend.

---

## 7. AI Model

- **Model name:** ECNet Hybrid (`arch: hybrid`)
- **Spatial model:** EfficientNet-B4 NoisyStudent (`tf_efficientnet_b4_ns`, `pretrained: true`) via `timm` — per-frame spatial artifacts
- **Temporal model:** ConvLSTM over the backbone feature maps — `hidden_channels: 256`, `kernel_size: 3` — temporal artifacts (flicker, drift)
- **Fusion classifier:** MLP head, `fusion_hidden: 256`, `dropout: 0.3` — combines spatial + temporal into the final logit
- **Loss function:** `BCEWithLogitsLoss`, combined with auxiliary branch losses:
  `loss = BCE(fused) + 0.3 · (BCE(spatial) + BCE(temporal))`  (`aux_loss_weight: 0.3`)
- **Optimizer:** AdamW, `weight_decay: 1e-4`
- **Learning rates:**
  - Phase 1 (frozen backbone) head: `lr_head = 1e-3`
  - Phase 2 head: `lr_finetune_head = 1e-4`
  - Phase 2 backbone: `lr_backbone = 1e-5`
  - Scheduler: `CosineAnnealingLR`
- **Input size:** 380 × 380 (square)
- **Number of frames:** 32 per video = `window_len (16)` × `n_windows (2)`, sampled at `target_fps: 12`
- **Output classes:** 2 (binary) — `real` vs `ai_generated`; a single sigmoid logit

---

## 8. Dataset

- **Train Set — 70%:** fits the model weights (backpropagation).
- **Validation Set — 15%:** tunes early stopping and the calibration threshold; never trained on.
- **Test Set — 15%:** held-out final evaluation; touched once, after training.
- Splits are **video-level** and **stratified by class × platform × orientation**, so val/test contain a representative mix and no video (or its crop) leaks across splits.

---

## 9. Training Pipeline

1. **Dataset loading:** read extracted-frame index CSVs, merge, build a video-level manifest.
2. **Frame extraction:** 2 contiguous windows × 16 frames per video at time-normalized 12 fps.
3. **Preprocessing:** letterbox-bar trim → resize to 380×380 square → ImageNet normalization; Albumentations augmentations (aspect jitter, squash, flip, lighting, resolution, compression, blur, noise, overlays).
4. **Feature extraction:** EfficientNet-B4 encodes each frame (spatial branch).
5. **Temporal learning:** ConvLSTM processes the 16-frame window feature maps (temporal branch).
6. **Fusion:** spatial + temporal features → fusion MLP → final logit.
7. **Loss computation:** `BCE(fused) + 0.3·(BCE(spatial)+BCE(temporal))`.
8. **Backpropagation:** AdamW; Phase 1 (3 epochs, frozen backbone) → Phase 2 (12 epochs, top 3 blocks unfrozen), mixed precision (AMP) on GPU.
9. **Validation:** per-epoch video-level AUC on the val set.
10. **Checkpoint saving:** `last.pt` every epoch; `best.pt` on val-AUC improvement.
11. **Early stopping:** stop after `early_stop_patience: 4` epochs with no val-AUC improvement.

---

## 10. Evaluation Metrics (definitions)

- **Training Loss:** BCE on the train set — how well it fits training data.
- **Validation Loss:** BCE on val — generalization signal (also calibration).
- **Test Loss:** BCE on the held-out test set.
- **Training / Validation / Test Accuracy:** fraction of correct predictions in each split.
- **Precision:** of clips predicted AI, how many are truly AI.
- **Recall (Sensitivity / TPR):** of truly-AI clips, how many were caught.
- **F1-Score:** harmonic mean of precision and recall.
- **ROC Curve:** TPR vs FPR across all thresholds.
- **AUC:** area under the ROC curve (frame/window level).
- **Video AUC:** AUC after averaging window scores per video — the primary metric.
- **Confusion Matrix:** 2×2 table of TP / FP / TN / FN.
- **True Positive (TP):** AI clip correctly called AI.
- **True Negative (TN):** real clip correctly called real.
- **False Positive (FP):** real clip wrongly called AI.
- **False Negative (FN):** AI clip wrongly called real.
- **False Positive Rate (FPR):** FP ÷ (FP + TN).
- **False Negative Rate (FNR):** FN ÷ (FN + TP).
- **Balanced Accuracy:** mean of TPR and TNR — fair under class imbalance; used to pick the threshold.
- **Calibration Threshold (t\*):** decision cutoff chosen on the val set (max balanced accuracy) and stored inside `best.pt`; verdict bands derive from it.

---

## 11. Metric Formulas

- **Accuracy** = (TP + TN) / (TP + TN + FP + FN)
- **Precision** = TP / (TP + FP)
- **Recall (TPR)** = TP / (TP + FN)
- **F1-Score** = 2 · (Precision · Recall) / (Precision + Recall)
- **FPR** = FP / (FP + TN)
- **FNR** = FN / (FN + TP)
- **Balanced Accuracy** = (TPR + TNR) / 2, where TNR = TN / (TN + FP)
- **Binary Cross-Entropy (BCE)** = −(1/N) Σ [ yᵢ·log(pᵢ) + (1−yᵢ)·log(1−pᵢ) ]
- **Focal BCE** (reference — the system uses plain BCE, not focal):
  FL = −(1/N) Σ αₜ·(1 − pₜ)^γ · log(pₜ)
- **ROC AUC (concept):** the probability that a randomly chosen AI clip receives a higher score than a randomly chosen real clip; equals the area under the TPR-vs-FPR curve.

---

## 12. Inference Pipeline

1. **Upload video** — frontend sends the file to `POST /analyze`.
2. **Frame extraction** — decode 2 windows × 16 frames (duration-scaled up to 8 windows for long clips).
3. **Preprocessing** — bar-trim → resize 380×380 → ImageNet normalize (identical to training).
4. **Model inference** — hybrid forward pass produces spatial, temporal, and fused logits.
5. **Probability computation** — sigmoid of the fused logit, averaged across windows.
6. **Confidence score** — distance of the score from the decision boundary, 0–100.
7. **Final prediction** — verdict from the checkpoint's calibrated bands: `real` / `uncertain` / `fake`, plus GradCAM heatmap boxes.

---

## 13. Backend API

Base URL: `http://localhost:8000` locally, or the Modal URL in production
(see [`training/DEPLOY.md`](training/DEPLOY.md)).

- **`GET /health`** — returns `{"status":"ok","checkpoint":"<path>"}`; confirms the server is up and which checkpoint is loaded.
- **`POST /analyze`** — multipart form field `video` (the uploaded file). Returns the analysis JSON (see §17). Errors: `422` if the video can't be decoded, `500` if the server was started without `--checkpoint`.
- **CORS:** any `http://localhost:<port>` / `http://127.0.0.1:<port>` origin is always allowed for dev. Deployed frontends must be listed in `ECNET_ALLOWED_ORIGINS`.

---

## 14. Folder Structure

```
AIGeneratedDetection/
├── index.html                 Vite entry HTML
├── package.json               frontend deps + scripts
├── vite.config.ts
├── tsconfig*.json
├── .env.local                 (created by you — see §16)
├── public/                    static assets
├── src/                       FRONTEND
│   ├── main.tsx  App.tsx
│   ├── pages/                 LandingPage, ResultsPage
│   ├── components/            Hero, NavBar, sections/, tool/
│   │   └── tool/              UploadSection, ConfidenceGauge, HeatmapViewer,
│   │                          HistoryPanel, ResultsView, VideoPreview, ...
│   ├── context/               AnalysisContext.tsx  (app state)
│   ├── hooks/                 useAnalysisHistory.ts, useReveal.ts
│   ├── utils/                 realBackend.ts, videoStore.ts, captureThumbnail.ts,
│   │                          videoMetadata.ts, validateVideoFile.ts
│   ├── theme/                 ThemeContext, theme.css
│   ├── mock/                  mockData.ts  (used when real backend is off)
│   └── types/index.ts
└── training/                  BACKEND + ML
    ├── requirements.txt
    ├── serve.bat              quick model-switch launcher (Windows)
    ├── configs/
    │   └── v1_spatial.yaml    model + training config
    ├── src/                   PYTHON PACKAGE
    │   ├── server.py          FastAPI inference server (API)
    │   ├── inference.py       predict() — video → JSON
    │   ├── model.py           hybrid model (spatial + ConvLSTM + fusion)
    │   ├── dataset.py         window dataset + augmentation
    │   ├── extract_frames.py  frame extraction
    │   ├── build_manifest.py  split manifest
    │   ├── train.py           training loop
    │   ├── evaluate.py        metrics (per-source FPR, per-generator AUC)
    │   └── utils.py           decoding, resize-square, checkpoint IO
    ├── models/                CHECKPOINTS  (best.pt goes here)
    ├── notebooks/             Kaggle notebooks (data, extract, train)
    ├── data/                  local frames / raw video (git-ignored)
    └── outputs/               training run outputs (checkpoints, metrics)
```

The trained model is a single file: `training/models/best.pt`.

---

## 15. Commands (setup → run)

**One-time — frontend (from project root):**
```
npm install
```

**One-time — backend (from `training/`):**
```
python -m venv .venv
```
- Activate (Windows PowerShell): `.venv\Scripts\Activate.ps1`
- Activate (Windows cmd): `.venv\Scripts\activate.bat`
- Activate (macOS/Linux): `source .venv/bin/activate`
```
pip install -r requirements.txt
```

**Run the backend (from `training/`, venv active):**
```
python -m src.server --checkpoint models/best.pt
```
Windows shortcut (frees port 8000 first): `serve models\best.pt`

**Run the frontend (from project root, separate terminal):**
```
npm run dev
```
Then open the printed URL (e.g. `http://localhost:5173/`).

**Build the frontend (production):**
```
npm run build
npm run preview
```

**Run inference from the command line (from `training/`, venv active):**
```
python -m src.inference --checkpoint models/best.pt --video path\to\clip.mp4
```

---

## 16. Environment Variables

Create `.env.local` in the **project root** (copy from `.env.local.example`):

```
VITE_USE_REAL_BACKEND=true
VITE_BACKEND_URL=http://localhost:8000
```

- `VITE_USE_REAL_BACKEND` — `true` calls the real model server; unset/false uses the built-in mock.
- `VITE_BACKEND_URL` — where the FastAPI server is listening (default `http://localhost:8000`).

For a deployed backend, point `VITE_BACKEND_URL` at the Modal URL instead. `VITE_*` values are baked in at build time, so changing them needs a rebuild.

Backend env vars — all optional, the checkpoint path is still passed via `--checkpoint`:

- `ECNET_ALLOWED_ORIGINS` — comma-separated origins allowed through CORS (e.g. `https://ai-video-detection-five.vercel.app`). Required once the frontend is not on localhost.
- `ECNET_HOST` — bind address, default `127.0.0.1`. Must be `0.0.0.0` in a container.
- `PORT` — bind port, default `8000`. Most PaaS inject this.

On Modal these are set for you by `modal_app.py`.

---

## 17. Output (per analyzed video)

The backend returns JSON with:

- **Prediction / Verdict:** `verdict` — `"real"`, `"uncertain"`, or `"fake"`.
- **Score:** `fakeScore` — 0 (real) … 100 (AI), the position on the real→fake axis.
- **Confidence:** `confidence` — 0–100.
- **Probability bands:** `bands` — `{ realBelow, fakeAbove }`, the checkpoint's calibrated thresholds.
- **Branch scores:** `branchScores` — `{ spatial, opticalFlow (=temporal branch), frequency: null }`, each 0–100.
- **Heatmap:** `frames` — list of `{ index, time, boxes:[{x,y,w,h,intensity}] }` (GradCAM regions).
- **File name:** `fileName`.
- **Model version:** `modelVersion` — added by the server (e.g. `ecnet-hybrid-tf_efficientnet_b4_ns`).
- **Processing time:** `processingMs` — measured by the frontend and shown in the result.
- **History:** the frontend saves each result (metadata + thumbnail in `localStorage`, video in IndexedDB) so past analyses can be reopened and replayed.
