# ECNet — Training Pipeline (fully AI-generated video detection)

Trains a **hybrid detector** for fully AI-generated video (real vs
ai_generated): an **EfficientNet** backbone scores full square-resized frames
(spatial artifacts: textures, watermarks, seams) while a **ConvLSTM** scores
contiguous frame windows (temporal artifacts: flicker, identity drift), and a
fusion head combines both — one model, trained jointly end to end. Frames are
never cropped: AI-generation artifacts are global and many AI clips contain no
face at all. Frame scores aggregate to a video-level verdict matching the web
frontend's JSON contract (including GradCAM "suspicious region" boxes).

> **Preprocessing contract:** extraction, training, and inference all use
> the same `resize_square()` (whole frame squashed to a square — no crop, no
> bars, so orientation carries no signal). Breaking
> this symmetry silently destroys accuracy.

## Setup

```powershell
cd training
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

GPU (NVIDIA) — install the CUDA build of torch **first**, then the rest:

```powershell
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
pip install -r requirements.txt
```

## Two ways to get frames

**A. Kaggle batches (recommended for big datasets):** run
`notebooks/kaggle_extract_frames.ipynb` once per category (`BATCH_TAG =
"aigen"`, then `"real"`). Download/attach each batch's tar + CSV, extract
the tars so frames land under `data/frames/...`, and drop the
`frames_index_*.csv` files into `data/`. The manifest stage merges every
`data/frames_index*.csv` automatically.

**B. Local extraction:** put videos here and run stage 1:

```
data/raw/
├── real/                 # label 0 — ALL real videos, any origin
└── fake/
    └── ai_generated/     # label 1
```

Subfolders inside those are fine (they're scanned recursively).

## Run the pipeline (from `training/`, venv active)

| Stage | Command |
|---|---|
| 1. Extract frames | `python -m src.extract_frames --config configs/v1_spatial.yaml` |
| 2. Build manifest + splits | `python -m src.build_manifest --config configs/v1_spatial.yaml` |
| 3. Train | `python -m src.train --config configs/v1_spatial.yaml` |
| 4. Evaluate | `python -m src.evaluate --checkpoint outputs/<run>/best.pt --split test` |
| 5. Inference | `python -m src.inference --video path\to\clip.mp4 --checkpoint outputs/<run>/best.pt --out result.json` |

Resume an interrupted training run:

```powershell
python -m src.train --config configs/v1_spatial.yaml --resume outputs/<run>/last.pt
```

## Smoke test first (always)

Before a full run, prove the plumbing end-to-end on a handful of videos:

```powershell
python -m src.extract_frames --config configs/v1_spatial.yaml --limit 4
python -m src.build_manifest --config configs/v1_spatial.yaml
python -m src.train --config configs/v1_spatial.yaml     # let it run 1–2 epochs, Ctrl+C
python -m src.evaluate --checkpoint outputs/<run>/last.pt --split val
python -m src.inference --video data\raw\real\<any>.mp4 --checkpoint outputs/<run>/last.pt
```

For fast iteration set `model.backbone: tf_efficientnet_b0_ns` and
`extraction.image_size: 224` in the config (re-run extraction after changing
image size).

Tip: a healthy first sign during real training is the model overfitting a
tiny subset — if it *can't* drive training loss near zero on 50 videos,
something is wired wrong.

## What to check after each stage

- **Stage 2 prints a source × split table.** Verify every source (real,
  ai_generated) has videos in train, val, AND test, and that the
  class-balance line isn't warning (e.g. 5000 real vs 3000 ai_generated is
  62/38 — either cap real or set `train.use_weighted_sampler: true`). The
  script hard-asserts that no video appears in two splits, and stage 3
  refuses to start if any split has only one class.
- **Stage 3 writes `outputs/<run>/curves.png`.** Train loss falling while
  val loss rises = overfitting; early stopping will catch it, but look anyway.
- **Stage 4 prints per-source metrics** plus the sliced tables (orientation,
  resolution, per-generator) — the shortcut/generalization instruments.

## Config knobs (`configs/v1_spatial.yaml`)

| Key | Meaning |
|---|---|
| `paths.data_root` | root that `frame_path` entries are relative to (Kaggle tars extract here) |
| `paths.frames_index_glob` | which index CSVs the manifest merges (local + Kaggle batches) |
| `extraction.window_len` / `n_windows` / `frame_stride` | contiguous windows for the hybrid's ConvLSTM: `n_windows` windows of `window_len` frames, `frame_stride` source-frames apart (16×2, stride 2 = 32 frames/video). `window_len: 1` = old uniform spatial sampling |
| `extraction.image_size` | square frame resolution; 380 for b4, 224 for b0 |
| `splits.scene_regex` | groups derived videos (e.g. `<stem>_pcrop_<hash>` portrait crops) with their originals into one split — the leakage guard |
| `model.backbone` | any timm EfficientNet; b4 = accuracy, b0 = speed |
| `train.epochs_head` / `epochs_finetune` | phase 1 (frozen backbone) / phase 2 (top blocks unfrozen) |
| `train.lr_backbone` | keep ~100× lower than head LR — pretrained features only need nudging |
| `train.use_weighted_sampler` | turn on if the balance warning fires |
| `train.early_stop_patience` | epochs without val video-AUC improvement before stopping |
| `inference.cam_threshold` / `max_boxes` | GradCAM box sensitivity / cap |

## Design notes (why it's built this way)

- **Full-frame resize-to-square, never cropped.** AI-generation evidence is
  global — watermarks, background morphing, texture sliding — and many AI
  clips have no face at all, so the whole frame is always analyzed.
- **Video-level, leakage-safe splits.** Frames of one video are
  near-duplicates; the manifest assigns splits per *video*, and
  `scene_regex` keeps derived videos (portrait crops) with their originals
  on the same side. Violating either silently inflates every metric.
- **Batch-mergeable extraction.** Frame paths are stored relative to
  `data_root` and every `frames_index*.csv` is merged at the manifest
  stage — so extracting AI-gen and real in separate Kaggle sessions is
  pure logistics, with no effect on splits or training.
- **Augment live, never cache features.** Caching backbone features would
  freeze the backbone forever and kill augmentation; this pipeline keeps
  frames on disk and runs the backbone every epoch.
- **Video-level metrics.** The product answers "is this *video* fake", so
  AUC/accuracy are computed after aggregating frame probabilities per video.
- **Two-phase transfer learning.** New random head first (frozen backbone),
  then unfreeze the top blocks at a low LR.

## Adding the v2 frequency branch later (the seam)

`src/model.py` documents this next to the code. In short:

1. Write `FrequencyBranch(nn.Module)` (input: FFT spectrum → 1 logit or a feature vector).
2. Register it in `ECNetModel.branches["frequency"]`.
3. Extend `dataset.py` to also return the spectrum for each frame
   (`torch.fft.fft2` on the grayscale crop, log-magnitude, normalized).
4. Replace `ECNetModel.forward`'s pass-through with a small fusion head
   over the concatenated branch outputs.
5. Add a `model.branches` toggle in the config; retrain **on the full
   dataset** (never fine-tune a new branch on a slice — catastrophic
   forgetting).
6. `inference.py`: populate `branchScores.frequency` from the new branch.

Training/eval loops only depend on `model(x) -> logit` and won't change.

## Troubleshooting

- **decord missing on Windows** → expected; OpenCV fallback is automatic.
- **CUDA out of memory** → lower `train.batch_size`, or switch to
  `tf_efficientnet_b0_ns` + `image_size: 224`.
- **Training refuses to start ("split contains 1 class")** → you built the
  manifest with only one batch merged (e.g. AI-gen but no real). Put both
  batches' `frames_index_*.csv` in `data/`, extract both tars, rebuild the
  manifest.
- **`FileNotFoundError: Missing frame on disk`** → `paths.data_root` doesn't
  point at where the frame folders actually live; frames must sit at
  `<data_root>/frames/<source>/<video_id>/`.
