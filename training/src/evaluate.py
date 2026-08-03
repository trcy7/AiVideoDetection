from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from sklearn.metrics import (
    accuracy_score,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from torch.utils.data import DataLoader
from tqdm import tqdm

from .dataset import FrameDataset, build_portrait_probe_transforms, build_transforms
from .model import ECNetModel
from .utils import get_device, load_checkpoint, load_config, set_seed, setup_logger


def safe_auc(y_true, y_prob) -> float:
    """AUC that returns NaN instead of crashing when only one class is present."""
    y_true = np.asarray(y_true)
    if len(np.unique(y_true)) < 2:
        return float("nan")
    return float(roc_auc_score(y_true, np.asarray(y_prob)))


@torch.no_grad()
def collect_frame_probs(model, loader, device, criterion=None) -> tuple[pd.DataFrame, float]:
    """Run the model over a with_meta loader -> per-frame probabilities.

    Returns (DataFrame[video_id, source, label, prob], mean_loss).
    """
    model.eval()
    records: list[dict] = []
    total_loss, seen = 0.0, 0
    for images, labels, video_ids, sources in tqdm(loader, desc="eval", leave=False):
        images = images.to(device, non_blocking=True)
        labels_dev = labels.to(device, non_blocking=True)
        logits = model(images)
        if criterion is not None:
            total_loss += criterion(logits, labels_dev).item() * len(labels)
            seen += len(labels)
        probs = torch.sigmoid(logits).cpu().numpy()
        for vid, source, label, prob in zip(video_ids, sources, labels.numpy(), probs):
            records.append({"video_id": vid, "source": source, "label": int(label), "prob": float(prob)})
    df = pd.DataFrame.from_records(records)
    return df, (total_loss / seen if seen else float("nan"))


def aggregate_videos(frame_df: pd.DataFrame) -> pd.DataFrame:
    """Frame probs -> one row per video (mean prob decides; max is diagnostic)."""
    return (
        frame_df.groupby("video_id")
        .agg(label=("label", "first"), source=("source", "first"), mean_prob=("prob", "mean"), max_prob=("prob", "max"))
        .reset_index()
    )


def compute_metrics(video_df: pd.DataFrame, threshold: float = 0.5) -> dict:
    y_true = video_df["label"].to_numpy()
    y_prob = video_df["mean_prob"].to_numpy()
    y_pred = (y_prob >= threshold).astype(int)
    return {
        "n_videos": int(len(video_df)),
        "auc": safe_auc(y_true, y_prob),
        "accuracy": float(accuracy_score(y_true, y_pred)),
        "precision": float(precision_score(y_true, y_pred, zero_division=0)),
        "recall": float(recall_score(y_true, y_pred, zero_division=0)),
        "f1": float(f1_score(y_true, y_pred, zero_division=0)),
        "confusion_matrix": confusion_matrix(y_true, y_pred, labels=[0, 1]).tolist(),
    }


def per_source_metrics(video_df: pd.DataFrame) -> dict[str, dict]:
    """Each fake source measured against the real videos (binary per source)."""
    out: dict[str, dict] = {}
    real = video_df[video_df["source"] == "real"]
    for source in sorted(s for s in video_df["source"].unique() if s != "real"):
        subset = pd.concat([real, video_df[video_df["source"] == source]])
        out[source] = compute_metrics(subset)
    return out


# --------------------------------------------------------------------------- #
# Per-GENERATOR evaluation. The `source` column only says real/ai_generated;
# the diversity batch (AVGen-Bench) tags the generator in the FILENAME
# ("avg_<model>_<hash>"), which survives inside video_id
# ("<source>__<stem>__<hash8>"). Breaking AUC out per generator shows exactly
# WHICH models the detector handles and which it doesn't — the cross-generator
# analysis the thesis needs. Untagged AI (the original pools) reports as
# "legacy_pool".
# --------------------------------------------------------------------------- #
def generator_of(video_id: str) -> str | None:
    """Generator tag for tagged AI videos, "legacy_pool" for untagged AI-style
    ids, None if the id can't be parsed. Real videos are never passed here."""
    parts = str(video_id).split("__")
    if len(parts) < 3:
        return None
    stem = "__".join(parts[1:-1])
    if stem.startswith("avg_"):
        tail = stem[4:]
        return tail.rsplit("_", 1)[0] if "_" in tail else tail   # drop the hash
    return "legacy_pool"


def per_generator_metrics(video_df: pd.DataFrame) -> dict[str, dict]:
    """AUC of (all real) vs (each generator's fakes). Small-n generators are
    still reported — read n_fake before trusting their AUC."""
    real = video_df[video_df["label"] == 0]
    fakes = video_df[video_df["label"] == 1].copy()
    if fakes.empty or real.empty:
        return {}
    fakes["generator"] = [generator_of(v) or "unparsed" for v in fakes["video_id"]]
    out: dict[str, dict] = {}
    for gen, grp in fakes.groupby("generator"):
        m = compute_metrics(pd.concat([real, grp]))
        out[str(gen)] = {"n_fake": int(len(grp)), "n_real": int(len(real)),
                         "auc": m["auc"], "accuracy": m["accuracy"], "recall_on_fakes": m["recall"]}
    return out


def real_source_of(video_id: str) -> str:
    """Which collection a REAL video came from, parsed from its stem prefix
    (the batch notebooks name deterministically: ugc_/vis_/pexl_/pex_/dact_).
    Everything else is the original stock/dataset pool."""
    parts = str(video_id).split("__")
    stem = "__".join(parts[1:-1]) if len(parts) >= 3 else str(video_id)
    for prefix, tag in (("ugc_", "youtube_ugc"), ("vis_", "vision_devices"),
                        ("pexl_", "pexels"), ("pex_", "pexels"), ("dact_", "deepaction")):
        if stem.startswith(prefix):
            return tag
    return "stock_pool"


def per_real_source_fpr(video_df: pd.DataFrame, threshold: float) -> dict[str, dict]:
    """False-positive rate per REAL source at the deployed threshold. THE
    round-2 success metric: wild sources (ugc/vision/pexels) should approach
    stock_pool's FPR once hard reals join training."""
    reals = video_df[video_df["label"] == 0].copy()
    if reals.empty:
        return {}
    reals["real_source"] = [real_source_of(v) for v in reals["video_id"]]
    out: dict[str, dict] = {}
    for src, grp in reals.groupby("real_source"):
        fp = int((grp["mean_prob"] >= threshold).sum())
        out[str(src)] = {"n": int(len(grp)), "false_positives": fp,
                         "fpr": round(fp / len(grp), 4)}
    return out


def format_real_source_report(per_src: dict[str, dict], threshold: float) -> str:
    lines = [f"=== false-positive rate per REAL source (at t*={threshold:.3f}) ===",
             f"{'real source':>16} {'n':>6} {'flagged':>8} {'FPR':>7}"]
    for src, m in sorted(per_src.items(), key=lambda kv: -kv[1]["fpr"]):
        note = "  <- small n, noisy" if m["n"] < 15 else ""
        lines.append(f"{src:>16} {m['n']:>6} {m['false_positives']:>8} {m['fpr']*100:>6.1f}%{note}")
    lines.append("  (goal: wild sources' FPR approaching stock_pool's)")
    return "\n".join(lines)


def format_generator_report(per_gen: dict[str, dict]) -> str:
    lines = ["=== AUC by generator (all real vs each generator's fakes) ===",
             f"{'generator':>24} {'n_fake':>7} {'auc':>7} {'acc':>7} {'recall':>7}"]
    scored = []
    for gen, m in sorted(per_gen.items(), key=lambda kv: (kv[1]["auc"] != kv[1]["auc"], kv[1]["auc"])):
        auc_s = f"{m['auc']:.3f}" if m["auc"] == m["auc"] else "n/a"
        flag = "  <- small n, noisy" if m["n_fake"] < 15 else ""
        lines.append(f"{gen:>24} {m['n_fake']:>7} {auc_s:>7} {m['accuracy']:>7.3f} "
                     f"{m['recall_on_fakes']:>7.3f}{flag}")
        if m["auc"] == m["auc"] and m["n_fake"] >= 15:
            scored.append((gen, m["auc"]))
    if scored:
        worst = min(scored, key=lambda x: x[1])
        lines.append(f"  weakest generator: {worst[0]} (AUC {worst[1]:.3f}) -- "
                     f"add data there or accept and report it.")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Sliced evaluation: is a nuisance factor (orientation / resolution) acting as
# a shortcut? Two symptoms to catch:
#   1. Class skew INSIDE a slice (e.g. all portrait videos are fake) -> the
#      factor is correlated with the label, so the model *can* cheat on it.
#   2. An AUC gap ACROSS slices (e.g. strong on 1080p, weak on <=360p) -> the
#      model didn't learn a robust cue for the weak slice.
# Needs the original pre-resize dims (orig_w/orig_h) recorded at extraction.
# --------------------------------------------------------------------------- #
def slice_of(w, h) -> tuple[str, str]:
    """(orientation, resolution_bucket) from ORIGINAL video dims. Returns
    ('unknown','unknown') when dims are missing (frames extracted before dims
    were recorded, or re-indexed squares)."""
    try:
        w, h = float(w), float(h)
    except (TypeError, ValueError):
        return "unknown", "unknown"
    if w != w or h != h or w <= 0 or h <= 0:   # NaN / missing / zero
        return "unknown", "unknown"
    r = w / h
    orient = "portrait" if r < 0.95 else "landscape" if r > 1.05 else "square"
    short = min(w, h)   # short side -> orientation-agnostic "p" bucket (upper bounds)
    res = ("<=360p" if short <= 360 else "<=480p" if short <= 480 else
           "<=720p" if short <= 720 else "<=1080p" if short <= 1080 else ">1080p")
    return orient, res


def add_slice_columns(video_df: pd.DataFrame, meta_df: pd.DataFrame) -> pd.DataFrame:
    """Join original dims (per video) onto video_df and derive slice columns."""
    meta = meta_df.drop_duplicates("video_id")[["video_id", "orig_w", "orig_h"]]
    out = video_df.merge(meta, on="video_id", how="left")
    slices = [slice_of(w, h) for w, h in zip(out["orig_w"], out["orig_h"])]
    out["orientation"] = [s[0] for s in slices]
    out["resolution"] = [s[1] for s in slices]
    return out


def sliced_metrics(video_df: pd.DataFrame, by: str) -> dict[str, dict]:
    """Video-level metrics within each slice of `by`, WITH class counts so a
    one-class (shortcut-prone) slice is obvious. AUC is NaN for single-class
    slices -- read n_real / n_fake there instead."""
    out: dict[str, dict] = {}
    for value, grp in video_df.groupby(by):
        y = grp["label"].to_numpy()
        n_real, n_fake = int((y == 0).sum()), int((y == 1).sum())
        m = compute_metrics(grp)
        out[str(value)] = {
            "n_videos": int(len(grp)), "n_real": n_real, "n_fake": n_fake,
            "fake_rate": round(n_fake / max(len(grp), 1), 3),
            "auc": m["auc"], "accuracy": m["accuracy"],
        }
    return out


def format_slice_report(name: str, sliced: dict[str, dict]) -> str:
    """Readable slice table + explicit SHORTCUT / WEAK-SLICE flags."""
    lines = [f"=== AUC by {name} ===",
             f"{'slice':>12} {'n':>5} {'real':>5} {'fake':>5} {'fake%':>6} {'auc':>7} {'acc':>7}"]
    aucs = []
    for value, m in sorted(sliced.items()):
        auc = m["auc"]
        if auc == auc and m["n_real"] > 0 and m["n_fake"] > 0:  # both classes -> AUC meaningful
            aucs.append(auc)
        auc_s = f"{auc:.3f}" if auc == auc else "n/a"
        lines.append(f"{value:>12} {m['n_videos']:>5} {m['n_real']:>5} {m['n_fake']:>5} "
                     f"{m['fake_rate'] * 100:>5.0f}% {auc_s:>7} {m['accuracy']:>7.3f}")
    for value, m in sorted(sliced.items()):
        if value == "unknown" or m["n_videos"] < 5:
            continue
        if m["fake_rate"] >= 0.85 or m["fake_rate"] <= 0.15:
            lines.append(f"  [SHORTCUT RISK] {name}={value} is {m['fake_rate'] * 100:.0f}% one class -- "
                         f"{name} correlates with the label here; the model can cheat on it. "
                         f"Add the missing class for this {name}.")
    if len(aucs) >= 2:
        gap = max(aucs) - min(aucs)
        if gap >= 0.10:
            lines.append(f"  [WEAK SLICE] AUC spans {min(aucs):.3f}-{max(aucs):.3f} across {name} "
                         f"(gap {gap:.3f}) -- much weaker on some {name} values; add data / stronger "
                         f"augmentation there.")
        else:
            lines.append(f"  [OK] AUC stable across {name} (gap {gap:.3f}) -- no {name} shortcut evident.")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--split", default="test", choices=["val", "test"])
    parser.add_argument("--config", default=None, help="defaults to the config stored in the checkpoint")
    args = parser.parse_args()

    device = get_device()
    ckpt = load_checkpoint(args.checkpoint, map_location=device)
    cfg = load_config(args.config) if args.config else ckpt["config"]
    set_seed(int(cfg["seed"]))

    run_dir = Path(args.checkpoint).parent
    logger = setup_logger("evaluate", run_dir / f"eval_{args.split}.log")

    model = ECNetModel(cfg).to(device)
    model.load_state_dict(ckpt["model"])

    manifest = pd.read_csv(cfg["paths"]["manifest"])
    split_df = manifest[manifest["split"] == args.split]
    if split_df.empty:
        logger.error(f"No rows for split '{args.split}' in {cfg['paths']['manifest']}")
        raise SystemExit(1)

    dataset = FrameDataset(
        split_df, build_transforms(cfg, train=False), cfg["paths"]["data_root"], with_meta=True
    )
    loader = DataLoader(
        dataset,
        batch_size=int(cfg["train"]["batch_size"]),
        shuffle=False,
        num_workers=int(cfg["train"]["num_workers"]),
        pin_memory=device.type == "cuda",
    )

    frame_df, _ = collect_frame_probs(model, loader, device)
    video_df = aggregate_videos(frame_df)
    video_df = add_slice_columns(video_df, split_df)

    results = {
        "split": args.split,
        "checkpoint": str(args.checkpoint),
        "overall": compute_metrics(video_df),
        "per_source": per_source_metrics(video_df),
        "by_orientation": sliced_metrics(video_df, "orientation"),
        "by_resolution": sliced_metrics(video_df, "resolution"),
        "by_generator": per_generator_metrics(video_df),
    }
    t_star = float(cfg.get("inference", {}).get("decision_threshold", 0.5))
    results["by_real_source_fpr"] = per_real_source_fpr(video_df, t_star)

    logger.info(f"=== {args.split.upper()} (video-level, {results['overall']['n_videos']} videos) ===")
    logger.info(json.dumps(results["overall"], indent=2))
    for source, metrics in results["per_source"].items():
        logger.info(f"--- real vs {source} ---")
        logger.info(json.dumps(metrics, indent=2))
    # Shortcut instrumentation: AUC broken out by orientation and resolution.
    logger.info(format_slice_report("orientation", results["by_orientation"]))
    logger.info(format_slice_report("resolution", results["by_resolution"]))
    if results["by_generator"]:
        logger.info(format_generator_report(results["by_generator"]))
    if results["by_real_source_fpr"]:
        logger.info(format_real_source_report(results["by_real_source_fpr"], t_star))

    # Portrait robustness probe: re-score the test set forced to portrait aspect.
    # A small AUC drop = squash-invariant = portrait uploads handled even though
    # training was all landscape.
    probe_ds = FrameDataset(split_df, build_portrait_probe_transforms(cfg),
                            cfg["paths"]["data_root"], with_meta=True)
    probe_loader = DataLoader(probe_ds, batch_size=int(cfg["train"]["batch_size"]), shuffle=False,
                              num_workers=int(cfg["train"]["num_workers"]), pin_memory=device.type == "cuda")
    probe_frame_df, _ = collect_frame_probs(model, probe_loader, device)
    probe_video = aggregate_videos(probe_frame_df)
    probe_auc = safe_auc(probe_video["label"], probe_video["mean_prob"])
    base_auc = results["overall"]["auc"]
    results["portrait_probe"] = {"auc": probe_auc, "base_auc": base_auc,
                                 "auc_drop": (base_auc - probe_auc) if probe_auc == probe_auc else None}
    drop = results["portrait_probe"]["auc_drop"]
    verdict = ("robust" if drop is not None and drop < 0.03 else
               "acceptable" if drop is not None and drop < 0.07 else "WEAK -> get portrait data")
    logger.info(f"=== portrait robustness probe (landscape test forced to 9:16) ===\n"
                f"  normal AUC {base_auc:.4f} -> portrait-squash AUC {probe_auc:.4f} "
                f"(drop {drop:.4f}) -> {verdict}" if drop is not None
                else "  portrait probe: AUC undefined (single-class test)")

    out_path = run_dir / f"metrics_{args.split}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)
    logger.info(f"Saved -> {out_path}")


if __name__ == "__main__":
    main()
