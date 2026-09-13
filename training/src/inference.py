"""Video -> frontend JSON (verdict, scores, GradCAM boxes).

Preprocessing matches training: each whole frame resized to a square (no crop/bars).
Returns fakeScore 0-100, verdict by the checkpoint's calibrated bands, per-branch
scores, and GradCAM boxes in full-frame normalized coords.

Usage: python -m src.inference --video x.mp4 --checkpoint models/ECNet-7.pt --out result.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
import torch

from .dataset import IMAGENET_MEAN, IMAGENET_STD
from .model import ECNetModel, build_model
from .utils import (
    common_content_box,
    get_device,
    load_checkpoint,
    load_config,
    read_video_frames,
    read_video_windows,
    resize_square,
)


def _to_tensor(face_rgb: np.ndarray, device: torch.device) -> torch.Tensor:
    x = face_rgb.astype(np.float32) / 255.0
    x = (x - np.array(IMAGENET_MEAN, dtype=np.float32)) / np.array(IMAGENET_STD, dtype=np.float32)
    return torch.from_numpy(x.transpose(2, 0, 1)).unsqueeze(0).to(device)


def _gradcam(model: ECNetModel, x: torch.Tensor) -> tuple[float, np.ndarray]:
    """Returns (fake_probability, cam) where cam is a 0..1 map over the input crop."""
    with torch.enable_grad():
        logit, feats = model.spatial.forward_with_features(x)
        grads = torch.autograd.grad(logit.sum(), feats)[0]  # (1, C, H, W)
    weights = grads.mean(dim=(2, 3), keepdim=True)
    cam = torch.relu((weights * feats).sum(dim=1)).squeeze(0)  # (H, W)
    cam = cam.detach().cpu().numpy()
    if cam.max() > cam.min():
        cam = (cam - cam.min()) / (cam.max() - cam.min())
    else:
        cam = np.zeros_like(cam)
    prob = float(torch.sigmoid(logit.detach()).item())
    return prob, cam


def _cam_to_boxes(
    cam: np.ndarray,
    threshold: float,
    max_boxes: int,
) -> list[dict]:
    """Threshold the CAM into components -> full-frame normalized boxes.
    Resize-to-square keeps normalized coords, so no un-padding is needed."""
    mask = (cam >= threshold).astype(np.uint8)
    if mask.sum() == 0:
        return []
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    ch, cw = cam.shape

    comps = sorted(range(1, n), key=lambda i: stats[i, cv2.CC_STAT_AREA], reverse=True)[:max_boxes]
    boxes = []
    for i in comps:
        bx, by, bw, bh = (stats[i, k] for k in (cv2.CC_STAT_LEFT, cv2.CC_STAT_TOP, cv2.CC_STAT_WIDTH, cv2.CC_STAT_HEIGHT))
        component_cam = cam[by : by + bh, bx : bx + bw]
        boxes.append(
            {
                "x": round(bx / cw, 4),
                "y": round(by / ch, 4),
                "w": round(bw / cw, 4),
                "h": round(bh / ch, 4),
                "intensity": round(float(component_cam.max()), 4),
            }
        )
    return boxes


# Fallback defaults for fields a checkpoint's config may be missing.
_INFERENCE_DEFAULTS = {
    "frames_per_video": 32,
    "windows_per_video": 2,    # min windows floor (very short clips)
    "max_score_windows": 48,   # tile the WHOLE clip up to this many windows
    "max_cam_windows": 8,      # per-frame GradCAM/heatmap only on this many (cost cap)
    "cam_threshold": 0.60,
    "max_boxes": 3,
    "verdict_real_below": 35,
    "verdict_fake_above": 65,
    "tta": False,              # off by default: calibration was fit without TTA
}


def _normalize_cfg(cfg: dict) -> dict:
    cfg = dict(cfg)
    cfg["inference"] = {**_INFERENCE_DEFAULTS, **cfg.get("inference", {})}
    extraction = dict(cfg.get("extraction", {}))
    extraction.setdefault("image_size", cfg.get("image_size", 380))
    # fill windowing knobs the notebook CFG omits, so window sampling matches training
    extraction.setdefault("window_len", 16)
    extraction.setdefault("target_fps", 12)
    extraction.setdefault("frame_stride", 2)
    cfg["extraction"] = extraction
    # weights get loaded anyway -> skip the pretrained download (offline, fast)
    model = dict(cfg.get("model", {}))
    model["pretrained"] = False
    cfg["model"] = model
    return cfg


def _adapt_state_dict(model, state: dict) -> dict:
    """Remap notebook checkpoint keys (spatial.*) to the local ModuleDict layout. No-op if they match."""
    model_keys = set(model.state_dict().keys())
    if set(state.keys()) <= model_keys:
        return state
    remapped = {}
    for k, v in state.items():
        if k.startswith("spatial.") and f"branches.{k}" in model_keys:
            remapped[f"branches.{k}"] = v  # notebook flat -> local ModuleDict
        elif k.startswith("branches.spatial.") and k[len("branches."):] in model_keys:
            remapped[k[len("branches."):]] = v  # reverse, just in case
        else:
            remapped[k] = v
    return remapped


def _window_probs(model, win_tensor: torch.Tensor, use_tta: bool
                  ) -> tuple[float, float, float, float | None, float | None]:
    """Per-window sigmoid probs; frequency/motion are None if the checkpoint lacks
    those branches. With TTA, averages the window with its horizontal mirror."""
    def _opt(o, key):
        return torch.sigmoid(o[key]) if key in o else None
    with torch.no_grad():
        out = model(win_tensor)
        fused = torch.sigmoid(out["logit"])
        spat = torch.sigmoid(out["spatial_logit"])
        temp = torch.sigmoid(out["temporal_logit"])
        freq = _opt(out, "frequency_logit")
        motion = _opt(out, "motion_logit")
        if use_tta:
            out_f = model(torch.flip(win_tensor, dims=(-1,)))  # mirror width
            fused = 0.5 * (fused + torch.sigmoid(out_f["logit"]))
            spat = 0.5 * (spat + torch.sigmoid(out_f["spatial_logit"]))
            temp = 0.5 * (temp + torch.sigmoid(out_f["temporal_logit"]))
            ff, mf = _opt(out_f, "frequency_logit"), _opt(out_f, "motion_logit")
            if freq is not None and ff is not None:
                freq = 0.5 * (freq + ff)
            if motion is not None and mf is not None:
                motion = 0.5 * (motion + mf)
    def _v(t):
        return float(t.item()) if t is not None else None
    return float(fused.item()), float(spat.item()), float(temp.item()), _v(freq), _v(motion)


def _predict_hybrid(video_path: str | Path, model, cfg: dict, device: torch.device) -> dict:
    """Hybrid: sample windows (count scales with duration) -> fused verdict;
    GradCAM boxes from the spatial branch. Preprocessing matches training."""
    ecfg, icfg = cfg["extraction"], cfg["inference"]
    image_size = int(ecfg["image_size"])
    use_tta = bool(icfg.get("tta", True))

    # Analyze the WHOLE clip: cover=True tiles it end to end (back-to-back
    # windows), instead of a few sparse samples that skipped most of a long clip.
    windows = read_video_windows(
        video_path,
        window_len=int(ecfg.get("window_len", 16)),
        n_windows=int(icfg.get("windows_per_video", 2)),   # floor for very short clips
        target_fps=float(ecfg.get("target_fps", 12)),
        fallback_stride=int(ecfg.get("frame_stride", 2)),
        cover=True,
        max_windows=int(icfg.get("max_score_windows", 48)),
    )  # raises ValueError if unreadable

    box = None
    if bool(ecfg.get("trim_black_borders", False)):
        box = common_content_box([rgb for win in windows for _, _, rgb in win])

    fused_probs: list[float] = []
    spatial_probs: list[float] = []
    temporal_probs: list[float] = []
    frequency_probs: list[float] = []
    motion_probs: list[float] = []
    frame_probs: dict[int, float] = {}     # keyed by source frame -> no double count
    frame_entries: dict[int, dict] = {}    # ditto; overlapping tiles share frames
    # Every window feeds the SCORE (whole-clip coverage). GradCAM is per-frame and
    # costly, so run it (and emit heatmap frames) only on a capped, evenly-spaced
    # subset -- keeps long uploads responsive and the frames payload bounded.
    # >=1: with zero CAM windows there'd be no heatmap and no per-frame probs,
    # which would silently degrade confidence to "frames fully disagree"
    max_cam_windows = max(1, int(icfg.get("max_cam_windows", 8)))
    if len(windows) > max_cam_windows:
        cam_windows = set(np.linspace(0, len(windows) - 1, max_cam_windows).round().astype(int).tolist())
    else:
        cam_windows = set(range(len(windows)))

    for wi, window in enumerate(windows):
        do_cam = wi in cam_windows
        tensors = []
        for src_idx, time_sec, rgb in window:
            full_h, full_w = rgb.shape[:2]
            if box is not None:
                t, b, l, r = box
                rgb = rgb[t:b, l:r]
            square = resize_square(rgb, image_size)
            x = _to_tensor(square, device)
            tensors.append(x.squeeze(0))
            if not do_cam:
                continue
            prob, cam = _gradcam(model, x)        # spatial branch: per-frame prob + CAM
            frame_probs[int(src_idx)] = prob
            boxes = _cam_to_boxes(cam, float(icfg["cam_threshold"]), int(icfg["max_boxes"]))
            if box is not None:
                t, b, l, r = box
                cw, ch = (r - l) / full_w, (b - t) / full_h
                for bx in boxes:
                    bx["x"] = round(l / full_w + bx["x"] * cw, 4)
                    bx["y"] = round(t / full_h + bx["y"] * ch, 4)
                    bx["w"] = round(bx["w"] * cw, 4)
                    bx["h"] = round(bx["h"] * ch, 4)
            # keyed by source frame: tiled windows can overlap, and the UI
            # scrubber needs unique frames in ascending time
            frame_entries[int(src_idx)] = {"time": round(float(time_sec), 3), "boxes": boxes}
        win_tensor = torch.stack(tensors).unsqueeze(0)   # (1, T, C, H, W)
        fused_p, spatial_p, temporal_p, freq_p, motion_p = _window_probs(model, win_tensor, use_tta)
        fused_probs.append(fused_p)
        spatial_probs.append(spatial_p)
        temporal_probs.append(temporal_p)
        if freq_p is not None:
            frequency_probs.append(freq_p)
        if motion_p is not None:
            motion_probs.append(motion_p)

    mean_prob = float(np.mean(fused_probs))               # the model's answer
    fake_score = round(mean_prob * 100.0, 1)
    if fake_score < float(icfg["verdict_real_below"]):
        verdict = "real"
    elif fake_score > float(icfg["verdict_fake_above"]):
        verdict = "fake"
    else:
        verdict = "uncertain"

    # ascending time + contiguous indices for the UI scrubber
    ordered = [frame_entries[k] for k in sorted(frame_entries)]
    frame_entries_out = [{"index": i, **e} for i, e in enumerate(ordered)]
    frame_prob_values = [frame_probs[k] for k in sorted(frame_probs)]

    # confidence: distance from the fence (fused) + do the frames agree (spatial)
    margin = abs(mean_prob - 0.5) * 2.0
    agreement = 1.0 - min(1.0, 2.0 * float(np.std(frame_prob_values)))
    confidence = round(min(99.0, max(5.0, 100.0 * (0.6 * margin + 0.4 * agreement))), 1)

    result = {
        "fileName": Path(video_path).name,
        "fakeScore": fake_score,
        "verdict": verdict,
        "confidence": confidence,
        # calibrated thresholds, so the UI draws the model's actual bands
        "bands": {
            "realBelow": float(icfg["verdict_real_below"]),
            "fakeAbove": float(icfg["verdict_fake_above"]),
        },
        # opticalFlow=ConvLSTM, frequency=FFT, motion=residual; null if branch absent
        "branchScores": {
            "spatial": round(float(np.mean(spatial_probs)) * 100.0, 1),
            "frequency": round(float(np.mean(frequency_probs)) * 100.0, 1) if frequency_probs else None,
            "opticalFlow": round(float(np.mean(temporal_probs)) * 100.0, 1),
            "motion": round(float(np.mean(motion_probs)) * 100.0, 1) if motion_probs else None,
        },
        "frames": frame_entries_out,
    }
    validate_result(result, float(icfg["verdict_real_below"]), float(icfg["verdict_fake_above"]))
    return result


def _predict_spatial(video_path: str | Path, model, cfg: dict, device: torch.device) -> dict:
    """Legacy spatial-only flow (old 1-branch checkpoints): per-frame prob + GradCAM."""
    icfg = cfg["inference"]
    use_tta = bool(icfg.get("tta", True))
    frames = read_video_frames(video_path, int(icfg["frames_per_video"]))  # raises ValueError if unreadable
    image_size = int(cfg["extraction"]["image_size"])

    # strip letterbox bars (one box for the whole video) if trained that way
    box = None
    if bool(cfg["extraction"].get("trim_black_borders", False)):
        box = common_content_box([rgb for _, _, rgb in frames])

    probs: list[float] = []
    frame_entries: list[dict] = []
    for out_index, (_, time_sec, rgb) in enumerate(frames):
        full_h, full_w = rgb.shape[:2]
        if box is not None:
            t, b, l, r = box
            rgb = rgb[t:b, l:r]
        square = resize_square(rgb, image_size)  # SAME preprocessing as training
        x = _to_tensor(square, device)
        prob, cam = _gradcam(model, x)
        if use_tta:
            prob_f, _ = _gradcam(model, torch.flip(x, dims=(-1,)))  # mirror -> average
            prob = 0.5 * (prob + prob_f)
        probs.append(prob)
        boxes = _cam_to_boxes(cam, float(icfg["cam_threshold"]), int(icfg["max_boxes"]))
        if box is not None:
            # CAM coords are normalized to the TRIMMED content; the frontend
            # overlays on the FULL frame (bars included) — remap.
            t, b, l, r = box
            cw, ch = (r - l) / full_w, (b - t) / full_h
            for bx in boxes:
                bx["x"] = round(l / full_w + bx["x"] * cw, 4)
                bx["y"] = round(t / full_h + bx["y"] * ch, 4)
                bx["w"] = round(bx["w"] * cw, 4)
                bx["h"] = round(bx["h"] * ch, 4)
        frame_entries.append({"index": out_index, "time": round(float(time_sec), 3), "boxes": boxes})

    mean_prob = float(np.mean(probs))
    std_prob = float(np.std(probs))
    fake_score = round(mean_prob * 100.0, 1)

    if fake_score < float(icfg["verdict_real_below"]):
        verdict = "real"
    elif fake_score > float(icfg["verdict_fake_above"]):
        verdict = "fake"
    else:
        verdict = "uncertain"

    margin = abs(mean_prob - 0.5) * 2.0
    agreement = 1.0 - min(1.0, 2.0 * std_prob)
    confidence = round(min(99.0, max(5.0, 100.0 * (0.6 * margin + 0.4 * agreement))), 1)

    result = {
        "fileName": Path(video_path).name,
        "fakeScore": fake_score,
        "verdict": verdict,
        "confidence": confidence,
        "bands": {
            "realBelow": float(icfg["verdict_real_below"]),
            "fakeAbove": float(icfg["verdict_fake_above"]),
        },
        "branchScores": {"spatial": fake_score, "frequency": None, "opticalFlow": None},
        "frames": frame_entries,
    }
    validate_result(result, float(icfg["verdict_real_below"]), float(icfg["verdict_fake_above"]))
    return result


class Predictor:
    """Loads a checkpoint once and reuses the resident model across videos
    (the server holds one, so requests don't reload ~450 MB each time)."""

    def __init__(self, checkpoint_path: str | Path, config_path: str | Path | None = None) -> None:
        self.device = get_device()
        ckpt = load_checkpoint(checkpoint_path, map_location=self.device)
        cfg = load_config(config_path) if config_path else ckpt["config"]
        self.cfg = _normalize_cfg(cfg)
        self.arch = str(self.cfg["model"].get("arch", "spatial")).lower()
        self.model = build_model(self.cfg).to(self.device)  # hybrid or spatial, per the checkpoint
        self.model.load_state_dict(_adapt_state_dict(self.model, ckpt["model"]))
        self.model.eval()

    def predict(self, video_path: str | Path) -> dict:
        if self.arch == "hybrid":
            return _predict_hybrid(video_path, self.model, self.cfg, self.device)
        return _predict_spatial(video_path, self.model, self.cfg, self.device)


def predict(video_path: str | Path, checkpoint_path: str | Path, config_path: str | Path | None = None) -> dict:
    """One-shot convenience (CLI / tests): build a Predictor and run one video.
    The server uses a long-lived Predictor instead, to avoid per-request loads."""
    return Predictor(checkpoint_path, config_path).predict(video_path)


def validate_result(result: dict, real_below: float = 35.0, fake_above: float = 65.0) -> None:
    """Assert the frontend contract (score range, verdict matches bands, box coords)."""
    assert isinstance(result["fileName"], str) and result["fileName"]
    assert 0.0 <= result["fakeScore"] <= 100.0
    assert 0.0 <= result["confidence"] <= 100.0
    score, verdict = result["fakeScore"], result["verdict"]
    expected = "real" if score < real_below else ("fake" if score > fake_above else "uncertain")
    assert verdict == expected, f"verdict {verdict} does not match thresholds for {score}"
    assert 0.0 <= result["branchScores"]["spatial"] <= 100.0
    # optional branches (frequency=FFT, opticalFlow=ConvLSTM, motion=residual):
    # each is either null (branch absent from the checkpoint) or a 0-100 score.
    for slot in ("frequency", "opticalFlow", "motion"):
        v = result["branchScores"].get(slot)
        assert v is None or 0.0 <= v <= 100.0, f"branchScores.{slot} out of range: {v}"
    for entry in result["frames"]:
        assert entry["index"] >= 0 and entry["time"] >= 0
        for box in entry["boxes"]:
            for key in ("x", "y", "w", "h", "intensity"):
                assert 0.0 <= box[key] <= 1.0, f"box.{key} out of range: {box[key]}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--config", default=None, help="defaults to the config stored in the checkpoint")
    parser.add_argument("--out", default=None, help="write JSON here (default: print to stdout)")
    args = parser.parse_args()

    try:
        result = predict(args.video, args.checkpoint, args.config)
    except ValueError as err:
        raise SystemExit(f"ERROR: {err}")

    payload = json.dumps(result, indent=2)
    if args.out:
        Path(args.out).write_text(payload, encoding="utf-8")
        print(f"Wrote {args.out}")
    else:
        print(payload)


if __name__ == "__main__":
    main()
