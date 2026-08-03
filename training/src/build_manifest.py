
from __future__ import annotations

import argparse
import glob as globlib
import random
import re
from pathlib import Path

import pandas as pd

from .utils import ensure_dir, load_config, setup_logger

SPLITS = ("train", "val", "test")


def scene_key(stem: str, pattern: re.Pattern | None) -> str | None:
    if pattern is None:
        return None
    m = pattern.match(stem)
    return m.group(1) if m else None


def assign_splits(
    videos: pd.DataFrame, ratios: dict[str, float], pattern: re.Pattern | None, seed: int
) -> dict[str, str]:
    """Returns {video_id: split}, honoring scene grouping + stratification."""
    # ---- build groups: videos that must stay together -----------------------
    # Key preference: scene key when the regex matches, else the video is its
    # own singleton group.
    videos = videos.copy()
    videos["group"] = [
        f"scene::{key}" if (key := scene_key(stem, pattern)) is not None else f"video::{vid}"
        for vid, stem in zip(videos["video_id"], videos["stem"])
    ]

    groups = (
        videos.groupby("group")
        .agg(video_ids=("video_id", list), sources=("source", lambda s: tuple(sorted(set(s)))))
        .reset_index()
    )
    groups["n_videos"] = groups["video_ids"].map(len)

    # ---- stratified greedy allocation ---------------------------------------
    # Bucket groups by their source signature (e.g. ("real",), ("ai_generated","real")),
    # then within each bucket assign whole groups to whichever split is
    # furthest below its target video count. Greedy + seeded shuffle keeps it
    # simple, deterministic, and close to the requested ratios.
    rng = random.Random(seed)
    assignment: dict[str, str] = {}

    for _, bucket in groups.groupby("sources"):
        bucket = bucket.sample(frac=1.0, random_state=rng.randint(0, 2**31 - 1))
        total = int(bucket["n_videos"].sum())
        targets = {s: total * ratios[s] for s in SPLITS}
        filled = {s: 0 for s in SPLITS}
        for _, row in bucket.iterrows():
            # deficit = how far below target; ties broken by split order
            split = max(SPLITS, key=lambda s: targets[s] - filled[s])
            filled[split] += int(row["n_videos"])
            for vid in row["video_ids"]:
                assignment[vid] = split

    return assignment


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="configs/v1_spatial.yaml")
    args = parser.parse_args()

    cfg = load_config(args.config)
    logger = setup_logger("manifest")

    index_files = sorted(globlib.glob(cfg["paths"]["frames_index_glob"]))
    if not index_files:
        logger.error(
            f"No index CSVs match {cfg['paths']['frames_index_glob']} — run "
            "`python -m src.extract_frames` or drop Kaggle batch CSVs into data/."
        )
        raise SystemExit(1)
    logger.info("Merging index files: " + ", ".join(index_files))

    frames = pd.concat([pd.read_csv(p) for p in index_files], ignore_index=True)
    before = len(frames)
    # A video re-extracted in two batches must not count twice. Key on
    # frame_path (unique per written file), NOT frame_index: overlapping
    # windows on a short clip legitimately share frame_index across windows,
    # and deduping on it would silently delete rows and break window lengths.
    frames = frames.drop_duplicates(subset=["video_id", "frame_path"], keep="first")
    if len(frames) != before:
        logger.warning(f"Dropped {before - len(frames)} duplicate frame rows across batches.")

    frames["label"] = (frames["source"] != "real").astype(int)

    regex = cfg["splits"].get("scene_regex")
    pattern = re.compile(regex) if regex else None
    ratios = {s: float(cfg["splits"][s]) for s in SPLITS}
    if abs(sum(ratios.values()) - 1.0) > 1e-6:
        logger.error(f"Split ratios must sum to 1.0, got {ratios}")
        raise SystemExit(1)

    videos = frames.drop_duplicates("video_id")[["video_id", "stem", "source"]]
    assignment = assign_splits(videos, ratios, pattern, int(cfg["seed"]))
    frames["split"] = frames["video_id"].map(assignment)

    # ---- guardrail: a video must never straddle splits -----------------------
    per_video_splits = frames.groupby("video_id")["split"].nunique()
    assert (per_video_splits == 1).all(), "BUG: some video_id appears in more than one split"

    # orig_w/orig_h feed the sliced test eval (AUC by orientation & resolution);
    # window_index/pos_in_window group frames into the contiguous windows the
    # ConvLSTM branch consumes. Older index CSVs may lack them -> fill defaults
    # so the spatial pipeline still runs on legacy data.
    for col, default in (("orig_w", float("nan")), ("orig_h", float("nan")),
                         ("window_index", 0), ("pos_in_window", 0)):
        if col not in frames.columns:
            frames[col] = default
    manifest = frames[["video_id", "frame_path", "time_sec", "label", "source", "split",
                       "orig_w", "orig_h", "window_index", "pos_in_window"]]
    manifest_path = Path(cfg["paths"]["manifest"])
    ensure_dir(manifest_path.parent)
    manifest.to_csv(manifest_path, index=False)

    # ---- report ---------------------------------------------------------------
    vid_table = (
        frames.drop_duplicates("video_id")
        .pivot_table(index="source", columns="split", values="video_id", aggfunc="count", fill_value=0)
        .reindex(columns=list(SPLITS))
    )
    frame_table = (
        frames.pivot_table(index="source", columns="split", values="frame_path", aggfunc="count", fill_value=0)
        .reindex(columns=list(SPLITS))
    )
    logger.info("Videos per source x split:\n" + vid_table.to_string())
    logger.info("Frames per source x split:\n" + frame_table.to_string())

    # every source must appear in every split
    missing = [(src, sp) for src in vid_table.index for sp in SPLITS if vid_table.loc[src, sp] == 0]
    for src, sp in missing:
        logger.warning(f"Source '{src}' has ZERO videos in split '{sp}' — add data or adjust ratios.")

    uniq = frames.drop_duplicates("video_id")
    if uniq["label"].nunique() < 2:
        only = "real" if uniq["label"].iloc[0] == 0 else "fake"
        logger.warning("=" * 72)
        logger.warning(f"ONLY ONE CLASS PRESENT ({only}). This manifest cannot train a")
        logger.warning("classifier — merge the other batch (real/ai_generated) first.")
        logger.warning("=" * 72)
    real_frac = float((uniq["label"] == 0).mean())
    logger.info(f"Class balance (videos): real={real_frac:.1%}, fake={1 - real_frac:.1%}")
    if real_frac < 0.40 or real_frac > 0.60:
        logger.warning("=" * 72)
        logger.warning(f"CLASS IMBALANCE: real fraction is {real_frac:.1%} (outside 40–60%).")
        logger.warning("Either rebalance the data or set train.use_weighted_sampler: true.")
        logger.warning("=" * 72)

    logger.info(f"Wrote {len(manifest)} rows -> {manifest_path}")


if __name__ == "__main__":
    main()
