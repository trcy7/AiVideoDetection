"""Shared utilities: config, seeding, logging, checkpoints, video reading, faces."""

from __future__ import annotations

import logging
import random
import sys
from pathlib import Path
from typing import Any, Optional

import cv2
import numpy as np
import torch
import yaml

# ImageNet normalization, shared by the training transforms and inference.
IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


# --------------------------------------------------------------------------- config


def load_config(path: str | Path) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def ensure_dir(path: str | Path) -> Path:
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return p


# --------------------------------------------------------------------- reproducibility


def set_seed(seed: int) -> None:
    """One seed for python/numpy/torch so runs are repeatable."""
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


def get_device() -> torch.device:
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


# --------------------------------------------------------------------------- logging


def setup_logger(name: str, log_file: Optional[str | Path] = None) -> logging.Logger:
    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)
    logger.handlers.clear()
    fmt = logging.Formatter("%(asctime)s | %(levelname)s | %(message)s", "%H:%M:%S")

    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(fmt)
    logger.addHandler(console)

    if log_file is not None:
        ensure_dir(Path(log_file).parent)
        fh = logging.FileHandler(log_file, encoding="utf-8")
        fh.setFormatter(fmt)
        logger.addHandler(fh)
    return logger


# ------------------------------------------------------------------------ checkpoints


def save_checkpoint(path: str | Path, **state: Any) -> None:
    ensure_dir(Path(path).parent)
    torch.save(state, path)


def load_checkpoint(path: str | Path, map_location: Any = "cpu") -> dict[str, Any]:
    return torch.load(path, map_location=map_location, weights_only=False)


# ----------------------------------------------------------------------- video reading


def read_video_frames(
    video_path: str | Path, n_frames: int
) -> list[tuple[int, float, np.ndarray]]:
    """Uniformly sample up to `n_frames` RGB frames from a video.

    Returns [(frame_index, time_sec, rgb_array), ...]. Tries decord (fast)
    and falls back to OpenCV. Raises ValueError if the file can't be decoded.
    """
    video_path = str(video_path)
    try:
        return _read_with_decord(video_path, n_frames)
    except ImportError:
        pass
    return _read_with_opencv(video_path, n_frames)


def _uniform_indices(total: int, n: int) -> list[int]:
    if total <= 0:
        return []
    n = min(n, total)
    return sorted({int(round(i)) for i in np.linspace(0, total - 1, n)})


def _read_with_decord(path: str, n_frames: int) -> list[tuple[int, float, np.ndarray]]:
    import decord  # noqa: F401  (optional dependency)

    reader = decord.VideoReader(path)
    total = len(reader)
    fps = float(reader.get_avg_fps()) or 30.0
    indices = _uniform_indices(total, n_frames)
    if not indices:
        raise ValueError(f"No frames in video: {path}")
    batch = reader.get_batch(indices).asnumpy()  # already RGB
    return [(idx, idx / fps, frame) for idx, frame in zip(indices, batch)]


def _read_with_opencv(path: str, n_frames: int) -> list[tuple[int, float, np.ndarray]]:
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise ValueError(f"Cannot open video: {path}")
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frames: list[tuple[int, float, np.ndarray]] = []
    for idx in _uniform_indices(total, n_frames):
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, bgr = cap.read()
        if not ok:
            continue
        frames.append((idx, idx / fps, cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)))
    cap.release()
    if not frames:
        raise ValueError(f"Could not decode any frames from: {path}")
    return frames


# --------------------------------------------------- black-border trim
# Some source files carry letterbox/pillarbox bars BAKED INTO THE PIXELS
# (portrait content inside a landscape container, cinema bars, ...). If one
# class has more of those, the bars become a label cue — the same orientation
# shortcut resize_square was built to kill, sneaking back in through the
# pixels. So both extraction and inference trim uniform near-black borders
# before resizing. Conservative by design: only near-black, near-uniform edge
# rows/cols are trimmed, each side by at most max_trim_frac, and a degenerate
# result falls back to the full frame.


def black_border_box(
    rgb: np.ndarray, thresh: int = 12, bar_frac: float = 0.99, max_trim_frac: float = 0.40
) -> tuple[int, int, int, int]:
    """Content box (top, bottom, left, right) of one frame after stripping
    near-black border rows/cols. bottom/right are EXCLUSIVE indices."""
    h, w = rgb.shape[:2]
    dark = rgb.max(axis=2) < thresh                  # a colored bar is not "black"
    row_bar = dark.mean(axis=1) >= bar_frac          # rows that are ~entirely black
    col_bar = dark.mean(axis=0) >= bar_frac
    max_v, max_h = int(h * max_trim_frac), int(w * max_trim_frac)

    top = 0
    while top < max_v and row_bar[top]:
        top += 1
    bottom = h
    while bottom > h - max_v and row_bar[bottom - 1]:
        bottom -= 1
    left = 0
    while left < max_h and col_bar[left]:
        left += 1
    right = w
    while right > w - max_h and col_bar[right - 1]:
        right -= 1
    if bottom - top < h * 0.3 or right - left < w * 0.3:   # degenerate (e.g. black frame)
        return 0, h, 0, w
    return top, bottom, left, right


def common_content_box(frames: list[np.ndarray]) -> tuple[int, int, int, int]:
    """MINIMAL trim across frames: a border is removed only if it is a bar in
    EVERY frame (min-trim = union of content). Robust to fades/dark scenes,
    and gives all frames of a video the same geometry — required so a
    contiguous window doesn't get fake per-frame crop jitter."""
    h, w = frames[0].shape[:2]
    boxes = [black_border_box(f) for f in frames]
    top = min(b[0] for b in boxes)
    bottom = max(b[1] for b in boxes)
    left = min(b[2] for b in boxes)
    right = max(b[3] for b in boxes)
    if bottom - top < h * 0.3 or right - left < w * 0.3:
        return 0, h, 0, w
    return top, bottom, left, right


# ------------------------------------------------ contiguous windows (hybrid)
# The spatial branch is happy with single frames, but the ConvLSTM temporal
# branch needs to SEE MOTION: consecutive frames, not 0.5s-apart snapshots.
# So extraction samples n_windows CONTIGUOUS windows of window_len frames each,
# spread across the clip for content coverage. The planner GENERALIZES uniform
# sampling: window_len=1 reproduces the old spatial-only behavior exactly.
#
# The in-window stride is TIME-NORMALIZED (target_fps), not a fixed source-
# frame count: AI generators often render at 8-24fps while real cameras shoot
# 30-60fps, so a fixed stride would make the wall-clock motion step differ by
# class — the ConvLSTM could then classify by motion magnitude (i.e. by source
# fps), a pure shortcut. Computing stride = fps/target_fps per video gives
# every window the same ~wall-clock step regardless of source frame rate.


def stride_for_fps(fps: float, target_fps: float, fallback: int = 2) -> int:
    """Source-frame stride so consecutive window frames are ~1/target_fps
    seconds apart. Falls back when fps is unknown/broken."""
    if not fps or fps <= 0 or not target_fps or target_fps <= 0:
        return max(1, int(fallback))
    return max(1, int(round(fps / target_fps)))


def plan_windows(total: int, window_len: int, n_windows: int, frame_stride: int) -> list[list[int]]:
    """Up to n_windows lists of window_len CONTIGUOUS source-frame indices,
    spread across [0, total). Shrinks stride to fit short clips; clamps (pads)
    the tail for clips shorter than one window."""
    if total <= 0 or window_len < 1 or n_windows < 1:
        return []
    stride = max(1, int(frame_stride))
    while stride > 1 and (window_len - 1) * stride + 1 > total:
        stride -= 1                                  # short clip -> tighten the window
    span = (window_len - 1) * stride + 1
    last_start = max(0, total - span)
    if n_windows == 1:
        starts = [last_start // 2]
    else:
        starts = [int(round(k * last_start / (n_windows - 1))) for k in range(n_windows)]
    starts = sorted(dict.fromkeys(starts))           # dedupe identical starts (very short clips)
    return [[min(s + i * stride, total - 1) for i in range(window_len)] for s in starts]


def plan_windows_cover(total: int, window_len: int, frame_stride: int, max_windows: int) -> list[list[int]]:
    """Tile the ENTIRE clip: back-to-back windows of window_len frames at
    frame_stride covering [0, total) with no gaps. If tiling needs more than
    max_windows, widen the stride so the whole clip still fits the budget."""
    if total <= 0 or window_len < 1 or max_windows < 1:
        return []
    stride = max(1, int(frame_stride))
    while stride > 1 and (window_len - 1) * stride + 1 > total:
        stride -= 1                                      # short clip -> tighten the window
    span = (window_len - 1) * stride + 1                 # frames one window reaches across
    n = max(1, int(np.ceil(total / span)))
    if n > max_windows and window_len > 1:               # too long -> widen stride to fit the cap
        need = total / max_windows                       # frames each window must span
        stride = max(stride, int(np.ceil((need - 1) / (window_len - 1))))
        span = (window_len - 1) * stride + 1
        n = max(1, int(np.ceil(total / span)))
    # Hard cap. window_len==1 can't widen its span, so it subsamples instead of
    # covering -- full coverage is impossible there by construction.
    n = min(n, max_windows)
    last_start = max(0, total - span)
    # Even spacing over [0, last_start]. With n == ceil(total/span) the step is
    # <= span, so the windows still tile the clip without gaps.
    starts = (sorted({int(round(k * last_start / (n - 1))) for k in range(n)})
              if n > 1 else [last_start // 2])
    return [[min(s + i * stride, total - 1) for i in range(window_len)] for s in starts]


def _plan(total, window_len, n_windows, stride, cover, max_windows):
    """cover=True tiles the whole clip; else samples n_windows spread across it."""
    return (plan_windows_cover(total, window_len, stride, max_windows) if cover
            else plan_windows(total, window_len, n_windows, stride))


def read_video_windows(
    video_path: str | Path,
    window_len: int,
    n_windows: int,
    target_fps: float = 12.0,
    fallback_stride: int = 2,
    cover: bool = False,
    max_windows: int = 48,
) -> list[list[tuple[int, float, np.ndarray]]]:
    """Read CONTIGUOUS windows of window_len RGB frames for the hybrid's temporal
    branch, in-window stride TIME-NORMALIZED to target_fps (see stride_for_fps).
    cover=True tiles the WHOLE clip (up to max_windows); else samples n_windows
    spread across it. Returns [[(frame_index, time_sec, rgb), ...], ...]. decord,
    then OpenCV fallback. Raises ValueError if the file can't be decoded."""
    video_path = str(video_path)
    try:
        return _windows_with_decord(video_path, window_len, n_windows, target_fps, fallback_stride, cover, max_windows)
    except ImportError:
        pass
    return _windows_with_opencv(video_path, window_len, n_windows, target_fps, fallback_stride, cover, max_windows)


def _windows_with_decord(path, window_len, n_windows, target_fps, fallback_stride, cover=False, max_windows=48):
    import decord  # noqa: F401  (optional dependency)

    reader = decord.VideoReader(path)
    total = len(reader)
    fps = float(reader.get_avg_fps()) or 30.0
    stride = stride_for_fps(fps, target_fps, fallback_stride)
    plans = _plan(total, window_len, n_windows, stride, cover, max_windows)
    if not plans:
        raise ValueError(f"No frames in video: {path}")
    flat = sorted({i for w in plans for i in w})          # decode each needed frame once
    batch = reader.get_batch(flat).asnumpy()              # already RGB
    lut = {idx: frame for idx, frame in zip(flat, batch)}
    return [[(i, i / fps, lut[i]) for i in w] for w in plans]


def _windows_with_opencv(path, window_len, n_windows, target_fps, fallback_stride, cover=False, max_windows=48):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise ValueError(f"Cannot open video: {path}")
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    stride = stride_for_fps(fps, target_fps, fallback_stride)
    plans = _plan(total, window_len, n_windows, stride, cover, max_windows)
    lut: dict[int, np.ndarray] = {}
    if plans:
        flat = sorted({i for w in plans for i in w})
        for idx in flat:
            cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ok, bgr = cap.read()
            if ok:
                lut[idx] = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    cap.release()
    # keep only COMPLETE windows so the ConvLSTM always gets a fixed length
    windows = [[(i, i / fps, lut[i]) for i in w] for w in plans if all(i in lut for i in w)]
    if windows:
        return windows
    # Frame-INDEX seeking failed. This is the norm for WebM/VP9 (and some VFR
    # phone clips): CAP_PROP_FRAME_COUNT reads 0 and cap.set(POS_FRAMES) lands
    # nowhere, so nothing decodes. Fall back to SEQUENTIAL decode, which never
    # relies on the broken seek index.
    return _windows_sequential(path, window_len, n_windows, target_fps, fallback_stride, cover, max_windows)


def _windows_sequential(path, window_len, n_windows, target_fps, fallback_stride,
                        cover=False, max_windows=48, max_frames: int = 12000):
    """Decode frames in order (no seeking) and build windows from what actually
    came out. Robust for containers OpenCV can't seek (WebM/VP9). Capped at
    max_frames so a very long clip can't exhaust memory."""
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise ValueError(f"Cannot open video: {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frames: list[np.ndarray] = []
    while len(frames) < max_frames:
        ok, bgr = cap.read()
        if not ok:
            break
        frames.append(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    cap.release()
    total = len(frames)
    if total == 0:
        raise ValueError(f"Could not decode any frames from: {path}")
    stride = stride_for_fps(fps, target_fps, fallback_stride)
    plans = _plan(total, window_len, n_windows, stride, cover, max_windows)
    windows = [[(i, i / fps, frames[i]) for i in w] for w in plans if all(i < total for i in w)]
    if not windows:
        raise ValueError(
            f"Only {total} frame(s) decoded from {path} -- too short for a "
            f"{window_len}-frame window.")
    return windows


# ------------------------------------------------------------------------- letterbox


def resize_square(rgb: np.ndarray, size: int) -> np.ndarray:
    """Resizes the WHOLE frame to a size x size square, distorting the aspect
    ratio (no padding, no cropping). Every pixel of the source frame survives.

    Chosen over letterbox padding deliberately: letterbox bakes the aspect
    ratio into the image as black bars, which the model can latch onto as a
    spurious real/fake cue (a portrait clip becomes mostly black — a foreign
    input it treats as fake). Squashing to a square keeps orientation OUT of
    the signal entirely; a portrait and a landscape clip become the same
    shape. Because resize is a uniform coordinate scaling, NORMALIZED (0..1)
    coordinates are identical between this square and the original frame, so
    GradCAM boxes map straight back with no un-padding.

    Training AND inference must call this identically, or the model sees a
    different input distribution than it learned on.
    """
    return cv2.resize(rgb, (size, size), interpolation=cv2.INTER_AREA)
