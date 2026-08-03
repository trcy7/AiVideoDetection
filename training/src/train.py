"""Stage 3: train the v1 spatial model.

Two phases, both config-driven:
  Phase 1 (epochs_head):     backbone frozen, only the head trains — the
                             pretrained features are used as-is while the new
                             random head finds its feet.
  Phase 2 (epochs_finetune): top backbone blocks unfrozen with a much lower,
                             discriminative LR; cosine decay.

Early stopping monitors VIDEO-level val AUC (frames are aggregated per
video), because that's the metric the product actually lives on.

Usage (from training/):
    python -m src.train --config configs/v1_spatial.yaml
    python -m src.train --config configs/v1_spatial.yaml --resume outputs/<run>/last.pt
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import matplotlib
import pandas as pd
import torch
import yaml
from torch import nn
from tqdm import tqdm

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402  (after backend selection)

from .dataset import make_dataloaders  # noqa: E402
from .evaluate import aggregate_videos, collect_frame_probs, safe_auc  # noqa: E402
from .model import ECNetModel  # noqa: E402
from .utils import (  # noqa: E402
    ensure_dir,
    get_device,
    load_checkpoint,
    load_config,
    save_checkpoint,
    set_seed,
    setup_logger,
)


def configure_phase(model: ECNetModel, cfg: dict, phase: int) -> tuple[torch.optim.Optimizer, object]:
    """(Re)build optimizer + scheduler for the given phase.

    Phase 1: freeze backbone, single param group (head, lr_head), constant LR.
    Phase 2: unfreeze top blocks, discriminative LRs (backbone low, head
             higher), cosine decay across the fine-tune epochs.
    """
    tcfg = cfg["train"]
    spatial = model.spatial
    if phase == 1:
        spatial.freeze_backbone()
        optimizer = torch.optim.AdamW(
            spatial.head.parameters(), lr=float(tcfg["lr_head"]), weight_decay=float(tcfg["weight_decay"])
        )
        scheduler = None
    else:
        spatial.freeze_backbone()
        spatial.unfreeze_top_blocks(int(tcfg["unfreeze_blocks"]))
        optimizer = torch.optim.AdamW(
            [
                {"params": spatial.backbone_trainable_params(), "lr": float(tcfg["lr_backbone"])},
                {"params": spatial.head.parameters(), "lr": float(tcfg["lr_finetune_head"])},
            ],
            weight_decay=float(tcfg["weight_decay"]),
        )
        scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=int(tcfg["epochs_finetune"]))
    return optimizer, scheduler


def train_one_epoch(model, loader, optimizer, criterion, device, scaler, use_amp) -> tuple[float, float]:
    model.train()
    total_loss, correct, seen = 0.0, 0, 0
    for images, labels in tqdm(loader, desc="train", leave=False):
        images, labels = images.to(device, non_blocking=True), labels.to(device, non_blocking=True)
        optimizer.zero_grad(set_to_none=True)
        with torch.autocast(device_type=device.type, enabled=use_amp):
            logits = model(images)
            loss = criterion(logits, labels)
        if scaler is not None:
            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()
        else:
            loss.backward()
            optimizer.step()
        total_loss += loss.item() * len(labels)
        correct += ((torch.sigmoid(logits) > 0.5).float() == labels).sum().item()
        seen += len(labels)
    return total_loss / max(seen, 1), correct / max(seen, 1)


@torch.no_grad()
def validate(model, loader, criterion, device) -> dict:
    frame_df, val_loss = collect_frame_probs(model, loader, device, criterion)
    video_df = aggregate_videos(frame_df)
    return {
        "val_loss": val_loss,
        "val_frame_auc": safe_auc(frame_df["label"], frame_df["prob"]),
        "val_video_auc": safe_auc(video_df["label"], video_df["mean_prob"]),
    }


def save_curves(history: list[dict], out_path: Path) -> None:
    epochs = [h["epoch"] for h in history]
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(11, 4))
    ax1.plot(epochs, [h["train_loss"] for h in history], label="train loss")
    ax1.plot(epochs, [h["val_loss"] for h in history], label="val loss")
    ax1.set_xlabel("epoch"), ax1.set_title("Loss (gap = overfitting signal)"), ax1.legend()
    ax2.plot(epochs, [h["train_acc"] for h in history], label="train acc")
    ax2.plot(epochs, [h["val_video_auc"] for h in history], label="val video AUC")
    ax2.set_xlabel("epoch"), ax2.set_title("Accuracy / AUC"), ax2.legend()
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="configs/v1_spatial.yaml")
    parser.add_argument("--resume", default=None, help="path to a last.pt to continue from")
    args = parser.parse_args()

    cfg = load_config(args.config)
    set_seed(int(cfg["seed"]))
    device = get_device()

    if args.resume:
        run_dir = Path(args.resume).parent
    else:
        run_dir = ensure_dir(Path(cfg["paths"]["outputs_dir"]) / f"run_{time.strftime('%Y%m%d_%H%M%S')}_v1")
    logger = setup_logger("train", run_dir / "train.log")
    logger.info(f"Run dir: {run_dir} | device: {device} | seed: {cfg['seed']}")
    with open(run_dir / "config.yaml", "w", encoding="utf-8") as f:
        yaml.safe_dump(cfg, f, sort_keys=False)

    manifest = pd.read_csv(cfg["paths"]["manifest"])
    # Fail fast, before any GPU time: a one-class split cannot train or
    # validate a classifier (val AUC would be NaN and early stopping would
    # fire without ever saving a meaningful best checkpoint).
    for split in ("train", "val"):
        classes = manifest.loc[manifest["split"] == split, "label"].nunique()
        if classes < 2:
            logger.error(
                f"Split '{split}' contains {classes} class(es). Merge BOTH the real "
                "and ai_generated batches, rebuild the manifest, then train."
            )
            raise SystemExit(1)

    train_loader, val_loader = make_dataloaders(cfg, manifest)
    logger.info(f"Train frames: {len(train_loader.dataset)} | Val frames: {len(val_loader.dataset)}")

    model = ECNetModel(cfg).to(device)
    criterion = nn.BCEWithLogitsLoss()
    use_amp = bool(cfg["train"].get("amp", True)) and device.type == "cuda"
    scaler = torch.amp.GradScaler("cuda") if use_amp else None

    epochs_head = int(cfg["train"]["epochs_head"])
    total_epochs = epochs_head + int(cfg["train"]["epochs_finetune"])
    patience = int(cfg["train"]["early_stop_patience"])

    start_epoch, best_auc, bad_epochs = 0, float("-inf"), 0
    history: list[dict] = []
    optimizer = scheduler = None

    if args.resume:
        ckpt = load_checkpoint(args.resume, map_location=device)
        model.load_state_dict(ckpt["model"])
        start_epoch = ckpt["epoch"] + 1
        best_auc = ckpt.get("best_metric", float("-inf"))
        history = ckpt.get("history", [])
        logger.info(f"Resumed from {args.resume} at epoch {start_epoch} (best video AUC {best_auc:.4f})")

    for epoch in range(start_epoch, total_epochs):
        phase = 1 if epoch < epochs_head else 2
        # (Re)configure at run start and at the phase boundary.
        if optimizer is None or epoch == epochs_head:
            optimizer, scheduler = configure_phase(model, cfg, phase)
            if args.resume and epoch == start_epoch:
                # Same-phase resume restores optimizer/scheduler state; a
                # resume that lands exactly on the boundary starts phase 2 fresh.
                if ckpt.get("phase") == phase and ckpt.get("optimizer"):
                    optimizer.load_state_dict(ckpt["optimizer"])
                    if scheduler is not None and ckpt.get("scheduler"):
                        scheduler.load_state_dict(ckpt["scheduler"])
                    if scaler is not None and ckpt.get("scaler"):
                        scaler.load_state_dict(ckpt["scaler"])
            n_trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
            logger.info(f"Phase {phase} | trainable params: {n_trainable:,}")

        train_loss, train_acc = train_one_epoch(model, train_loader, optimizer, criterion, device, scaler, use_amp)
        val_metrics = validate(model, val_loader, criterion, device)
        if scheduler is not None:
            scheduler.step()

        row = {
            "epoch": epoch,
            "phase": phase,
            "train_loss": round(train_loss, 5),
            "train_acc": round(train_acc, 5),
            "lr": optimizer.param_groups[0]["lr"],
            **{k: (round(v, 5) if v == v else None) for k, v in val_metrics.items()},  # NaN -> None
        }
        history.append(row)
        logger.info(
            f"epoch {epoch:02d} [phase {phase}] "
            f"train_loss={train_loss:.4f} acc={train_acc:.3f} | "
            f"val_loss={val_metrics['val_loss']:.4f} "
            f"frame_auc={val_metrics['val_frame_auc']:.4f} video_auc={val_metrics['val_video_auc']:.4f}"
        )

        state = dict(
            epoch=epoch,
            phase=phase,
            model=model.state_dict(),
            optimizer=optimizer.state_dict(),
            scheduler=scheduler.state_dict() if scheduler is not None else None,
            scaler=scaler.state_dict() if scaler is not None else None,
            best_metric=best_auc,
            history=history,
            config=cfg,
        )
        save_checkpoint(run_dir / "last.pt", **state)
        with open(run_dir / "history.json", "w", encoding="utf-8") as f:
            json.dump(history, f, indent=2)
        save_curves(history, run_dir / "curves.png")

        video_auc = val_metrics["val_video_auc"]
        if video_auc == video_auc and video_auc > best_auc:  # NaN-safe improvement check
            best_auc = video_auc
            state["best_metric"] = best_auc
            save_checkpoint(run_dir / "best.pt", **state)
            bad_epochs = 0
            logger.info(f"  new best video AUC {best_auc:.4f} -> saved best.pt")
        else:
            bad_epochs += 1
            if bad_epochs >= patience:
                logger.info(f"Early stopping: no val video-AUC improvement in {patience} epochs.")
                break

    logger.info(f"Done. Best val video AUC: {best_auc:.4f} | checkpoints in {run_dir}")


if __name__ == "__main__":
    main()
