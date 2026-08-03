"""Manifest-driven Dataset + augmentation pipelines.

Augmentation runs LIVE on frames every epoch (never precomputed backbone
features) so the backbone stays fine-tunable and each epoch sees fresh
degradations. Train-time augmentations deliberately mimic real-world video
damage — recompression, blur, downscaling — because a detector that only
works on pristine frames is useless.
"""

from __future__ import annotations

import random
from collections import Counter
from pathlib import Path

import albumentations as A
import cv2
import numpy as np
import pandas as pd
import torch
from albumentations.pytorch import ToTensorV2
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler

IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


class RandomOverlay(A.ImageOnlyTransform):
    """Synthetic watermark/UI overlays (text, logo boxes, caption bars) stamped
    on BOTH classes. Diagnosed cue this kills: wild reals carry platform UI /
    watermarks (TikTok logo, captions) while chunks of the AI pool carry
    generator watermarks — either way "overlaid graphics" must carry ZERO
    label signal, so training paints them onto everything, class-agnostically.
    Params are normalized coords -> ReplayCompose replays the SAME overlay on
    every frame of a window (static overlays, like real watermarks)."""

    _CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#_"

    def __init__(self, max_elements: int = 3, alpha=(0.35, 0.9), p: float = 0.3):
        super().__init__(p=p)
        self.max_elements = max_elements
        self.alpha = alpha

    def get_params(self):
        elems = []
        for _ in range(random.randint(1, self.max_elements)):
            elems.append({
                "kind": random.choice(["text", "box", "bar"]),
                "x": random.uniform(0.02, 0.72), "y": random.uniform(0.06, 0.92),
                "w": random.uniform(0.08, 0.45), "h": random.uniform(0.03, 0.12),
                "alpha": random.uniform(*self.alpha),
                "shade": random.choice([0, 255]),
                "text": "".join(random.choice(self._CHARS) for _ in range(random.randint(4, 12))),
                "scale": random.uniform(0.5, 1.4),
            })
        return {"elems": elems}

    def apply(self, img, elems=(), **params):
        out = img.copy()
        h, w = out.shape[:2]
        for e in elems:
            layer = out.copy()
            x, y = int(e["x"] * w), int(e["y"] * h)
            col = (int(e["shade"]),) * 3
            if e["kind"] == "text":
                cv2.putText(layer, e["text"], (x, y), cv2.FONT_HERSHEY_SIMPLEX,
                            max(0.3, e["scale"] * w / 640.0), col,
                            max(1, int(round(e["scale"] * 2))), cv2.LINE_AA)
            elif e["kind"] == "box":
                cv2.rectangle(layer, (x, y),
                              (min(w - 1, x + int(e["w"] * w)), min(h - 1, y + int(e["h"] * h))),
                              col, -1)
            else:  # caption-style bar across the full width
                cv2.rectangle(layer, (0, y), (w - 1, min(h - 1, y + int(e["h"] * h))), col, -1)
            out = cv2.addWeighted(layer, e["alpha"], out, 1.0 - e["alpha"], 0)
        return out

    def get_transform_init_args_names(self):
        return ("max_elements", "alpha")


class AnamorphicSquash(A.ImageOnlyTransform):
    """Re-squash a frame's aspect in place (stays same size). After
    resize_square, a LANDSCAPE frame is a horizontally-squashed square and a
    PORTRAIT frame is a vertically-squashed square -- so "works on portrait"
    means "invariant to squash direction". This applies BOTH squashes to your
    (landscape) training frames so a portrait upload stays in-distribution even
    with zero portrait data. f>1 compresses width (landscape-style); f<1
    compresses height (portrait-style); log-uniform => the two are equally
    likely. This is the invariance lever; real portrait data is the guarantee.
    """
    def __init__(self, ratio=(0.4, 2.5), p=0.5):
        super().__init__(p=p)
        self.ratio = ratio

    def apply(self, img, f=1.0, **params):
        h, w = img.shape[:2]
        if f >= 1.0:
            iw, ih = max(1, int(round(w / f))), h      # compress width (landscape squash)
        else:
            iw, ih = w, max(1, int(round(h * f)))      # compress height (portrait squash)
        small = cv2.resize(img, (iw, ih), interpolation=cv2.INTER_AREA)
        return cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)

    def get_params(self):
        lo, hi = self.ratio
        return {"f": float(np.exp(random.uniform(np.log(lo), np.log(hi))))}

    def get_transform_init_args_names(self):
        return ("ratio",)


def build_transforms(cfg: dict, train: bool) -> A.Compose:
    """Training augmentation, grouped by the SHORTCUT each group defends
    against. The design principle: randomize every capture/transmission
    nuisance factor (orientation, lighting, resolution, compression, blur,
    sensor noise) so none of them correlates with the label — the model is
    forced to rely on intrinsic generation artifacts, which SURVIVE these
    mild degradations, instead of e.g. "low-res => fake".

    Kept forensics-safe: transforms are probabilistic (p<1) and moderate, and
    blur/noise use OneOf so a single frame is never destroyed by stacking
    everything at once. Validation/inference get NONE of this."""
    size = int(cfg["extraction"]["image_size"])
    aug = cfg.get("augment", {})
    ops: list[A.BasicTransform] = [A.Resize(size, size)]
    if train:
        # -- ORIENTATION / FRAMING shortcut: aspect ratio, flips --
        if aug.get("aspect_jitter", True):
            # Frames are squashed squares; a user's clip can be any aspect, which
            # squashes differently. Random re-stretch keeps every aspect in-dist.
            ops.append(A.RandomResizedCrop(size=(size, size), scale=(0.7, 1.0), ratio=(0.5, 2.0), p=0.7))
        # Full-frame anamorphic squash covering BOTH directions -> a portrait
        # upload (vertical squash) stays in-distribution even with all-landscape
        # training data. Complements the crop-based jitter above.
        if aug.get("portrait_squash", True):
            ops.append(AnamorphicSquash(ratio=(0.4, 2.5), p=0.5))
        if aug.get("horizontal_flip", True):
            ops.append(A.HorizontalFlip(p=0.5))

        # -- LIGHTING / COLOR / WHITE-BALANCE / CAMERA shortcut --
        if aug.get("lighting", True):
            ops.append(A.RandomBrightnessContrast(brightness_limit=0.2, contrast_limit=0.2, p=0.5))
            ops.append(A.RandomGamma(gamma_limit=(80, 120), p=0.3))
            # mild hue/sat so color can't be a cue, without masking artifacts
            ops.append(A.HueSaturationValue(hue_shift_limit=10, sat_shift_limit=15, val_shift_limit=10, p=0.3))

        # -- RESOLUTION / QUALITY shortcut (fixes "low-res => fake") --
        # AGGRESSIVE (p=0.65, down to 0.2x): the <=480p slice was 93% one class,
        # so hard/frequent downscaling of REALs decorrelates resolution from the
        # label -- quality stops mattering. Mirrors the training notebook.
        if aug.get("resolution", True):
            ops.append(A.Downscale(scale_range=(0.2, 0.95), p=0.65))

        # -- COMPRESSION / CODEC / PLATFORM shortcut (fixes "compressed => fake") --
        if aug.get("compression", True):
            ops.append(A.ImageCompression(quality_range=(22, 90), p=0.6))

        # -- FOCUS / SHARPNESS shortcut: randomize in BOTH directions (real
        # phone footage is often over-sharpened, AI output soft), at most one
        # per frame so we don't over-degrade --
        if aug.get("blur", True):
            ops.append(A.OneOf([
                A.GaussianBlur(blur_limit=(3, 7), p=1.0),
                A.MotionBlur(blur_limit=(3, 9), p=1.0),
                A.Sharpen(alpha=(0.2, 0.4), lightness=(0.8, 1.0), p=1.0),
            ], p=0.3))

        # -- DEVICE / SENSOR-NOISE shortcut: at most one noise type, kept mild --
        if aug.get("noise", True):
            ops.append(A.OneOf([
                A.GaussNoise(std_range=(0.02, 0.10), p=1.0),
                A.ISONoise(color_shift=(0.01, 0.05), intensity=(0.1, 0.4), p=1.0),
            ], p=0.3))

        # -- WATERMARK / UI-OVERLAY shortcut: platform UI on wild reals,
        # generator watermarks on AI -- stamp synthetic overlays on BOTH
        # classes so overlaid graphics carry zero label signal --
        if aug.get("overlays", True):
            ops.append(RandomOverlay(max_elements=3, alpha=(0.35, 0.9), p=0.3))

    ops += [A.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD), ToTensorV2()]
    return A.Compose(ops)


def build_portrait_probe_transforms(cfg: dict) -> A.Compose:
    """Val preprocessing + a DETERMINISTIC portrait squash (f~=0.56, the 9:16
    vertical squash). Scoring the landscape test set through this MEASURES
    portrait robustness without any portrait data: if AUC holds vs the normal
    test AUC, the model is squash-invariant, i.e. portrait uploads are handled.
    A big drop means portrait is out-of-distribution -> get portrait data."""
    size = int(cfg["extraction"]["image_size"])
    return A.Compose([
        A.Resize(size, size),
        AnamorphicSquash(ratio=(0.5625, 0.5625), p=1.0),   # 9/16 vertical squash
        A.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD),
        ToTensorV2(),
    ])


class FrameDataset(Dataset):
    """One item per manifest row (= one squashed-to-square full frame).

    `frame_path` in the manifest is relative to the data root (portable
    across local runs and Kaggle batch tars), so the root is joined here.
    with_meta=True additionally returns (video_id, source) so evaluation can
    aggregate frame scores back to the video level.
    """

    def __init__(
        self,
        manifest: pd.DataFrame,
        transforms: A.Compose,
        data_root: str | Path,
        with_meta: bool = False,
    ):
        self.df = manifest.reset_index(drop=True)
        self.transforms = transforms
        self.data_root = Path(data_root)
        self.with_meta = with_meta

    def __len__(self) -> int:
        return len(self.df)

    def __getitem__(self, idx: int):
        row = self.df.iloc[idx]
        full_path = self.data_root / row["frame_path"]
        bgr = cv2.imread(str(full_path))
        if bgr is None:
            raise FileNotFoundError(f"Missing frame on disk: {full_path}")
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        image = self.transforms(image=rgb)["image"]
        label = torch.tensor(float(row["label"]), dtype=torch.float32)
        if self.with_meta:
            return image, label, str(row["video_id"]), str(row["source"])
        return image, label


def make_dataloaders(cfg: dict, manifest: pd.DataFrame) -> tuple[DataLoader, DataLoader]:
    """Train loader (shuffled/augmented) + val loader (deterministic, with meta)."""
    tcfg = cfg["train"]
    data_root = cfg["paths"]["data_root"]
    train_df = manifest[manifest["split"] == "train"]
    val_df = manifest[manifest["split"] == "val"]

    train_ds = FrameDataset(train_df, build_transforms(cfg, train=True), data_root)
    val_ds = FrameDataset(val_df, build_transforms(cfg, train=False), data_root, with_meta=True)

    sampler = None
    shuffle = True
    if tcfg.get("use_weighted_sampler", False):
        # Inverse-frequency weights so a lopsided real:fake ratio doesn't
        # bias the classifier toward the majority class.
        counts = Counter(train_df["label"].tolist())
        weights = np.array([1.0 / counts[label] for label in train_df["label"]], dtype=np.float64)
        sampler = WeightedRandomSampler(torch.from_numpy(weights), num_samples=len(weights), replacement=True)
        shuffle = False

    common = dict(
        batch_size=int(tcfg["batch_size"]),
        num_workers=int(tcfg["num_workers"]),
        pin_memory=torch.cuda.is_available(),
        persistent_workers=int(tcfg["num_workers"]) > 0,
    )
    train_loader = DataLoader(train_ds, shuffle=shuffle, sampler=sampler, drop_last=True, **common)
    val_loader = DataLoader(val_ds, shuffle=False, **common)
    return train_loader, val_loader


# --------------------------------------------------------------------------- #
# HYBRID (EfficientNet + ConvLSTM): windows, not frames.
# One item = one CONTIGUOUS window (T, C, H, W). The augmentation for a window
# is sampled ONCE and REPLAYED identically on every frame — per-frame random
# params (different noise/flip/crop each frame) would inject fake temporal
# flicker that swamps the real motion signal the ConvLSTM must learn.
# --------------------------------------------------------------------------- #


def build_window_transforms(cfg: dict, train: bool) -> A.ReplayCompose:
    """Same op list as build_transforms, wrapped in ReplayCompose so one
    parameter draw can be replayed across all frames of a window."""
    base = build_transforms(cfg, train)
    return A.ReplayCompose(base.transforms)


class WindowDataset(Dataset):
    """One item per (video_id, window_index): a (T, C, H, W) float tensor.

    Only COMPLETE windows (the modal frame count) are kept — the ConvLSTM
    needs a fixed sequence length; extraction already guarantees this, the
    filter is a guard against hand-edited manifests.
    """

    def __init__(
        self,
        manifest: pd.DataFrame,
        transforms: A.ReplayCompose,
        data_root: str | Path,
        with_meta: bool = False,
    ):
        df = manifest.reset_index(drop=True)
        groups = []
        expected = int(df.groupby(["video_id", "window_index"]).size().mode().iloc[0])
        dropped = 0
        for (vid, _widx), g in df.groupby(["video_id", "window_index"]):
            if len(g) != expected:
                dropped += 1
                continue
            g = g.sort_values("pos_in_window")
            groups.append({
                "video_id": str(vid),
                "source": str(g["source"].iloc[0]),
                "label": float(g["label"].iloc[0]),
                "frame_paths": g["frame_path"].tolist(),
            })
        if dropped:
            print(f"WindowDataset: dropped {dropped} incomplete windows (expected {expected} frames)")
        self.window_len = expected
        self.groups = groups
        self.transforms = transforms
        self.data_root = Path(data_root)
        self.with_meta = with_meta

    def __len__(self) -> int:
        return len(self.groups)

    def _read(self, rel: str) -> np.ndarray:
        full = self.data_root / rel
        bgr = cv2.imread(str(full))
        if bgr is None:
            raise FileNotFoundError(f"Missing frame on disk: {full}")
        return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

    def __getitem__(self, idx: int):
        g = self.groups[idx]
        first = self.transforms(image=self._read(g["frame_paths"][0]))
        frames = [first["image"]]
        replay = first["replay"]  # one param draw, replayed on every other frame
        for rel in g["frame_paths"][1:]:
            frames.append(A.ReplayCompose.replay(replay, image=self._read(rel))["image"])
        window = torch.stack(frames, dim=0)  # (T, C, H, W)
        label = torch.tensor(g["label"], dtype=torch.float32)
        if self.with_meta:
            return window, label, g["video_id"], g["source"]
        return window, label


def make_window_dataloaders(cfg: dict, manifest: pd.DataFrame) -> tuple[DataLoader, DataLoader]:
    """Hybrid loaders: batches of windows. batch_videos windows/step — each is
    window_len frames through the backbone, so this is the memory knob."""
    tcfg = cfg["train"]
    data_root = cfg["paths"]["data_root"]
    train_df = manifest[manifest["split"] == "train"]
    val_df = manifest[manifest["split"] == "val"]

    train_ds = WindowDataset(train_df, build_window_transforms(cfg, train=True), data_root)
    val_ds = WindowDataset(val_df, build_window_transforms(cfg, train=False), data_root, with_meta=True)

    sampler = None
    shuffle = True
    if tcfg.get("use_weighted_sampler", False):
        counts = Counter(g["label"] for g in train_ds.groups)
        weights = np.array([1.0 / counts[g["label"]] for g in train_ds.groups], dtype=np.float64)
        sampler = WeightedRandomSampler(torch.from_numpy(weights), num_samples=len(weights), replacement=True)
        shuffle = False

    common = dict(
        batch_size=int(tcfg.get("batch_videos", 4)),
        num_workers=int(tcfg["num_workers"]),
        pin_memory=torch.cuda.is_available(),
        persistent_workers=int(tcfg["num_workers"]) > 0,
    )
    train_loader = DataLoader(train_ds, shuffle=shuffle, sampler=sampler, drop_last=True, **common)
    val_loader = DataLoader(val_ds, shuffle=False, **common)
    return train_loader, val_loader
