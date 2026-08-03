from __future__ import annotations

import argparse
import csv
import hashlib
import re
from pathlib import Path

import cv2
from tqdm import tqdm

from .utils import (
    common_content_box,
    ensure_dir,
    load_config,
    read_video_windows,
    resize_square,
    setup_logger,
)

VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".mpg", ".mpeg", ".wmv"}

# source name -> folder under data/raw/. Missing folders are skipped.
SOURCE_DIRS = {
    "real": Path("real"),
    "ai_generated": Path("fake") / "ai_generated",
}

JPEG_QUALITY = 92


def make_video_id(source: str, video_path: Path, raw_dir: Path) -> str:
    """Stable, filesystem-safe id: source + sanitized stem + short path hash."""
    rel = video_path.relative_to(raw_dir).as_posix()
    digest = hashlib.sha1(rel.encode("utf-8")).hexdigest()[:8]
    stem = re.sub(r"[^A-Za-z0-9_-]", "_", video_path.stem)[:80]
    return f"{source}__{stem}__{digest}"


def list_videos(raw_dir: Path) -> list[tuple[str, Path]]:
    found: list[tuple[str, Path]] = []
    for source, sub in SOURCE_DIRS.items():
        base = raw_dir / sub
        if not base.exists():
            continue
        for p in sorted(base.rglob("*")):
            if p.suffix.lower() in VIDEO_EXTS and p.is_file():
                found.append((source, p))
    return found


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="configs/v1_spatial.yaml")
    parser.add_argument("--limit", type=int, default=None, help="max videos per source (smoke tests)")
    parser.add_argument("--overwrite", action="store_true", help="re-extract even if frames exist")
    args = parser.parse_args()

    cfg = load_config(args.config)
    raw_dir = Path(cfg["paths"]["raw_dir"])
    data_root = Path(cfg["paths"]["data_root"])
    frames_dir = ensure_dir(data_root / "frames")
    index_path = data_root / "frames_index_local.csv"
    ecfg = cfg["extraction"]
    # Contiguous windows for the hybrid's ConvLSTM branch (window_len=1 -> old
    # uniform spatial sampling). Defaults keep old configs working.
    window_len = int(ecfg.get("window_len", 16))
    n_windows = int(ecfg.get("n_windows", 2))
    # Time-normalized stride: same wall-clock step for 8fps AI clips and 60fps
    # phone clips, so motion magnitude can't encode the source frame rate.
    target_fps = float(ecfg.get("target_fps", 12))
    fallback_stride = int(ecfg.get("frame_stride", 2))
    # Strip baked-in letterbox bars so bar geometry can't encode orientation.
    trim_bars = bool(ecfg.get("trim_black_borders", True))
    image_size = int(ecfg["image_size"])

    logger = setup_logger("extract")

    videos = list_videos(raw_dir)
    if args.limit is not None:
        per_source: dict[str, list[tuple[str, Path]]] = {}
        for source, path in videos:
            per_source.setdefault(source, []).append((source, path))
        videos = [v for group in per_source.values() for v in group[: args.limit]]
    if not videos:
        logger.error(f"No videos found under {raw_dir}. Expected {sorted(str(s) for s in SOURCE_DIRS.values())}")
        raise SystemExit(1)

    logger.info(
        f"Found {len(videos)} videos | {n_windows} window(s) x {window_len} frames "
        f"@ ~{target_fps:g}fps effective = {n_windows * window_len} frames/video @ {image_size}px "
        f"(resize-to-square, bar-trim={'on' if trim_bars else 'off'}, contiguous windows)"
    )

    rows: list[dict[str, object]] = []
    skipped = 0
    for source, video_path in tqdm(videos, desc="videos"):
        video_id = make_video_id(source, video_path, raw_dir)
        out_dir = frames_dir / source / video_id

        existing = sorted(out_dir.glob("w*.jpg")) if out_dir.exists() else []
        if existing and not args.overwrite:
            # Re-index existing frames so the run stays resumable.
            for frame_path in existing:
                m = re.match(r"w(\d+)_p(\d+)_f(\d+)\.jpg", frame_path.name)
                if m:
                    rows.append({
                        "video_id": video_id,
                        "video_path": video_path.as_posix(),
                        "frame_path": frame_path.relative_to(data_root).as_posix(),
                        "frame_index": int(m.group(3)),
                        "time_sec": "",  # unknown when re-indexing
                        "source": source,
                        "stem": video_path.stem,
                        "orig_w": "",  # dims unknown when re-indexing squares
                        "orig_h": "",
                        "window_index": int(m.group(1)),
                        "pos_in_window": int(m.group(2)),
                    })
            continue

        try:
            windows = read_video_windows(video_path, window_len, n_windows, target_fps, fallback_stride)
        except ValueError as err:
            logger.warning(f"SKIP (unreadable): {video_path} — {err}")
            skipped += 1
            continue

        # One content box for the WHOLE video (minimal trim across all decoded
        # frames): consistent geometry inside each window — per-frame trims
        # would inject fake crop-jitter "motion" into the ConvLSTM's input.
        box = None
        if trim_bars:
            all_rgb = [rgb for window in windows for _, _, rgb in window
                       if rgb is not None and getattr(rgb, "size", 0) > 0]
            if all_rgb:
                box = common_content_box(all_rgb)

        ensure_dir(out_dir)
        for window_index, window in enumerate(windows):
            # A window must be COMPLETE + clean (fixed length) for the ConvLSTM;
            # drop the whole window if any frame is malformed.
            if any(rgb is None or getattr(rgb, "size", 0) == 0 or rgb.shape[0] < 2 or rgb.shape[1] < 2
                   for _, _, rgb in window):
                continue
            for pos, (frame_index, time_sec, rgb) in enumerate(window):
                if box is not None:
                    t, b, l, r = box
                    rgb = rgb[t:b, l:r]
                # CONTENT dims (post bar-trim, pre-resize): what the model
                # actually sees — feeds the orientation/resolution sliced eval.
                orig_h, orig_w = int(rgb.shape[0]), int(rgb.shape[1])
                square = resize_square(rgb, image_size)
                frame_name = f"w{window_index:02d}_p{pos:02d}_f{frame_index:06d}.jpg"
                frame_path = out_dir / frame_name
                cv2.imwrite(
                    str(frame_path),
                    cv2.cvtColor(square, cv2.COLOR_RGB2BGR),
                    [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY],
                )
                rows.append({
                    "video_id": video_id,
                    "video_path": video_path.as_posix(),
                    "frame_path": frame_path.relative_to(data_root).as_posix(),
                    "frame_index": frame_index,
                    "time_sec": round(time_sec, 3),
                    "source": source,
                    "stem": video_path.stem,
                    "orig_w": orig_w,
                    "orig_h": orig_h,
                    "window_index": window_index,
                    "pos_in_window": pos,
                })

    ensure_dir(index_path.parent)
    with open(index_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=["video_id", "video_path", "frame_path", "frame_index",
                        "time_sec", "source", "stem", "orig_w", "orig_h",
                        "window_index", "pos_in_window"],
        )
        writer.writeheader()
        writer.writerows(rows)

    n_videos = len({r["video_id"] for r in rows})
    logger.info(
        f"Done: {len(rows)} frames from {n_videos} videos -> {index_path} "
        f"(skipped {skipped} unreadable)"
    )


if __name__ == "__main__":
    main()
