"""ECNet models: spatial-only (ECNetModel) and the hybrid (ECNetHybrid)."""

from __future__ import annotations

import timm
import torch
from torch import nn


class SpatialBranch(nn.Module):
    """timm backbone -> global avg pool -> dropout -> linear -> 1 logit."""

    def __init__(self, backbone: str, pretrained: bool, dropout: float):
        super().__init__()
        # num_classes=0 + global_pool="avg" => backbone outputs a flat feature vector
        self.backbone = timm.create_model(backbone, pretrained=pretrained, num_classes=0, global_pool="avg")
        feat_dim = self.backbone.num_features
        self.head = nn.Sequential(nn.Dropout(dropout), nn.Linear(feat_dim, 1))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.head(self.backbone(x)).squeeze(1)  # (B,)

    def forward_with_features(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """Logit + last conv feature map (for GradCAM); pools manually to match forward()."""
        feats = self.backbone.forward_features(x)  # (B, C, H, W)
        pooled = feats.mean(dim=(2, 3))
        logit = self.head(pooled).squeeze(1)
        return logit, feats

    # ---- transfer-learning helpers ------------------------------------------

    def freeze_backbone(self) -> None:
        for p in self.backbone.parameters():
            p.requires_grad = False

    def unfreeze_top_blocks(self, n_blocks: int) -> None:
        """Unfreeze the last n_blocks backbone stages + conv_head/bn2 for fine-tuning."""
        blocks = getattr(self.backbone, "blocks", None)
        if blocks is not None:
            for stage in list(blocks)[-n_blocks:]:
                for p in stage.parameters():
                    p.requires_grad = True
        for attr in ("conv_head", "bn2"):
            module = getattr(self.backbone, attr, None)
            if module is not None:
                for p in module.parameters():
                    p.requires_grad = True

    def backbone_trainable_params(self):
        return [p for p in self.backbone.parameters() if p.requires_grad]


class ECNetModel(nn.Module):
    """Spatial-only variant (kept so old spatial checkpoints still load)."""

    def __init__(self, cfg: dict):
        super().__init__()
        mcfg = cfg["model"]
        self.branches = nn.ModuleDict(
            {
                "spatial": SpatialBranch(
                    backbone=mcfg["backbone"],
                    pretrained=bool(mcfg.get("pretrained", True)),
                    dropout=float(mcfg.get("dropout", 0.3)),
                )
            }
        )

    @property
    def spatial(self) -> SpatialBranch:
        return self.branches["spatial"]

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.spatial(x)


# HYBRID: EfficientNet (spatial) + ConvLSTM (temporal) + fusion, trained jointly.
# Fused logit is the answer; per-branch logits are aux losses + frontend scores.


class ConvLSTMCell(nn.Module):
    """Conv-gated LSTM cell; state keeps spatial layout so it reasons per region."""

    def __init__(self, in_channels: int, hidden_channels: int, kernel_size: int = 3):
        super().__init__()
        padding = kernel_size // 2
        self.hidden_channels = hidden_channels
        self.gates = nn.Conv2d(in_channels + hidden_channels, 4 * hidden_channels,
                               kernel_size, padding=padding)

    def forward(self, x, h, c):
        i, f, g, o = self.gates(torch.cat([x, h], dim=1)).chunk(4, dim=1)
        i, f, o = torch.sigmoid(i), torch.sigmoid(f), torch.sigmoid(o)
        c = f * c + i * torch.tanh(g)
        h = o * torch.tanh(c)
        return h, c


class TemporalBranch(nn.Module):
    """ConvLSTM over the per-frame backbone feature maps of one window."""

    def __init__(self, in_channels: int, hidden_channels: int = 256,
                 kernel_size: int = 3, dropout: float = 0.3):
        super().__init__()
        self.cell = ConvLSTMCell(in_channels, hidden_channels, kernel_size)
        self.head = nn.Sequential(nn.Dropout(dropout), nn.Linear(hidden_channels, 1))

    def forward(self, feats: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """feats: (B, T, F, h, w) -> (temporal feature (B, hidden), logit (B,))."""
        b, t, _, hh, ww = feats.shape
        h = feats.new_zeros(b, self.cell.hidden_channels, hh, ww)
        c = feats.new_zeros(b, self.cell.hidden_channels, hh, ww)
        for step in range(t):
            h, c = self.cell(feats[:, step], h, c)
        pooled = h.mean(dim=(2, 3))                     # (B, hidden)
        return pooled, self.head(pooled).squeeze(1)


class FrequencyBranch(nn.Module):
    """FFT log-magnitude per frame -> small CNN. Detects spectral generator fingerprints."""

    def __init__(self, feat_dim: int = 128, dropout: float = 0.3):
        super().__init__()
        self.feat_dim = feat_dim
        self.cnn = nn.Sequential(
            nn.Conv2d(1, 32, 3, stride=2, padding=1), nn.BatchNorm2d(32), nn.ReLU(inplace=True),
            nn.Conv2d(32, 64, 3, stride=2, padding=1), nn.BatchNorm2d(64), nn.ReLU(inplace=True),
            nn.Conv2d(64, feat_dim, 3, stride=2, padding=1), nn.BatchNorm2d(feat_dim), nn.ReLU(inplace=True),
            nn.AdaptiveAvgPool2d(1),
        )
        self.head = nn.Sequential(nn.Dropout(dropout), nn.Linear(feat_dim, 1))

    @staticmethod
    def _spectrum(x: torch.Tensor) -> torch.Tensor:
        # FFT needs float32 (unstable under AMP half).
        gray = x.float().mean(dim=1, keepdim=True)
        fft = torch.fft.fftshift(torch.fft.fft2(gray), dim=(-2, -1))
        logmag = torch.log1p(fft.abs())
        mu = logmag.mean(dim=(-2, -1), keepdim=True)
        sd = logmag.std(dim=(-2, -1), keepdim=True) + 1e-6
        return (logmag - mu) / sd                                    # per-frame z-norm

    def forward(self, frames: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        # frames: (N, C, H, W) -> (feat (N, feat_dim), logit (N,))
        feat = self.cnn(self._spectrum(frames)).flatten(1)
        return feat, self.head(feat).squeeze(1)


class MotionBranch(nn.Module):
    """Frame-difference motion branch. Pools per-residual features' mean+std over
    time; the std flags AI's motion flicker/incoherence."""

    def __init__(self, feat_dim: int = 128, dropout: float = 0.3):
        super().__init__()
        self.feat_dim = feat_dim
        self.out_dim = 2 * feat_dim   # mean + std over time
        self.cnn = nn.Sequential(
            nn.Conv2d(1, 32, 3, stride=2, padding=1), nn.BatchNorm2d(32), nn.ReLU(inplace=True),
            nn.Conv2d(32, 64, 3, stride=2, padding=1), nn.BatchNorm2d(64), nn.ReLU(inplace=True),
            nn.Conv2d(64, feat_dim, 3, stride=2, padding=1), nn.BatchNorm2d(feat_dim), nn.ReLU(inplace=True),
            nn.AdaptiveAvgPool2d(1),
        )
        self.head = nn.Sequential(nn.Dropout(dropout), nn.Linear(self.out_dim, 1))

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        # x: (B, T, C, H, W) -> (motion feature (B, 2*feat_dim), logit (B,))
        b, t, c, h, w = x.shape
        gray = x.float().mean(dim=2)                       # (B, T, H, W) luminance
        resid = (gray[:, 1:] - gray[:, :-1]).abs()         # (B, T-1, H, W) motion magnitude
        n = t - 1
        per = self.cnn(resid.reshape(b * n, 1, h, w)).flatten(1).reshape(b, n, self.feat_dim)
        feat = torch.cat([per.mean(dim=1), per.std(dim=1)], dim=1)   # (B, 2*feat_dim)
        return feat, self.head(feat).squeeze(1)


class ECNetHybrid(nn.Module):
    """Spatial + temporal (+ optional frequency/motion) + fusion. Input: (B, T, C, H, W).
    Extra branches are gated by config flags so 2-branch checkpoints still load."""

    def __init__(self, cfg: dict):
        super().__init__()
        mcfg = cfg["model"]
        lcfg = mcfg.get("convlstm", {})
        self.spatial = SpatialBranch(
            backbone=mcfg["backbone"],
            pretrained=bool(mcfg.get("pretrained", True)),
            dropout=float(mcfg.get("dropout", 0.3)),
        )
        feat_dim = self.spatial.backbone.num_features
        hidden = int(lcfg.get("hidden_channels", 256))
        self.temporal = TemporalBranch(
            in_channels=feat_dim,
            hidden_channels=hidden,
            kernel_size=int(lcfg.get("kernel_size", 3)),
            dropout=float(mcfg.get("dropout", 0.3)),
        )
        drop = float(mcfg.get("dropout", 0.3))
        fusion_in = feat_dim + hidden
        self.use_frequency = bool(mcfg.get("frequency_branch", False))
        if self.use_frequency:
            self.frequency = FrequencyBranch(int(mcfg.get("freq_dim", 128)), drop)
            fusion_in += self.frequency.feat_dim
        self.use_motion = bool(mcfg.get("motion_branch", False))
        if self.use_motion:
            self.motion = MotionBranch(int(mcfg.get("motion_dim", 128)), drop)
            fusion_in += self.motion.out_dim
        fusion_hidden = int(mcfg.get("fusion_hidden", 256))
        self.fusion = nn.Sequential(
            nn.Linear(fusion_in, fusion_hidden),
            nn.ReLU(inplace=True),
            nn.Dropout(float(mcfg.get("dropout", 0.3))),
            nn.Linear(fusion_hidden, 1),
        )
        # optional gate: learned softmax over [fusion + branch logits] so it can
        # fall back to the best branch (fixes fused < best-branch)
        self.use_logit_fusion = bool(mcfg.get("logit_fusion", False))
        if self.use_logit_fusion:
            n_members = 3 + int(self.use_frequency) + int(self.use_motion)  # fusion+spatial+temporal(+freq)(+motion)
            self.fusion_gate = nn.Parameter(torch.zeros(n_members))

    def _backbone_frozen(self) -> bool:
        return not any(p.requires_grad for p in self.spatial.backbone.parameters())

    def forward(self, x: torch.Tensor) -> dict[str, torch.Tensor]:
        """x: (B, T, C, H, W) -> dict of fused + per-branch logits."""
        b, t, c, h, w = x.shape
        flat = x.reshape(b * t, c, h, w)
        # frozen backbone (phase 1): no_grad saves activation memory
        if self._backbone_frozen():
            with torch.no_grad():
                fmaps = self.spatial.backbone.forward_features(flat)
        else:
            fmaps = self.spatial.backbone.forward_features(flat)
        fh, fw = fmaps.shape[-2], fmaps.shape[-1]
        fdim = fmaps.shape[1]

        pooled = fmaps.mean(dim=(2, 3))                          # (B*T, F)
        spatial_logit = self.spatial.head(pooled).squeeze(1).reshape(b, t).mean(dim=1)  # (B,)

        seq = fmaps.reshape(b, t, fdim, fh, fw)                  # (B, T, F, h, w)
        temporal_feat, temporal_logit = self.temporal(seq)       # (B, hidden), (B,)

        spatial_feat = pooled.reshape(b, t, fdim).mean(dim=1)    # (B, F)

        # fuse enabled branches; order (spatial, temporal, [freq], [motion]) matches fusion_in
        feats = [spatial_feat, temporal_feat]
        out = {"spatial_logit": spatial_logit, "temporal_logit": temporal_logit}
        if self.use_frequency:
            ff_flat, fl_flat = self.frequency(flat)
            feats.append(ff_flat.reshape(b, t, -1).mean(dim=1))
            out["frequency_logit"] = fl_flat.reshape(b, t).mean(dim=1)
        if self.use_motion:
            motion_feat, motion_logit = self.motion(x)
            feats.append(motion_feat)
            out["motion_logit"] = motion_logit
        fusion_logit = self.fusion(torch.cat(feats, dim=1)).squeeze(1)
        if self.use_logit_fusion:
            members = [fusion_logit, spatial_logit, temporal_logit]
            if self.use_frequency:
                members.append(out["frequency_logit"])
            if self.use_motion:
                members.append(out["motion_logit"])
            w = torch.softmax(self.fusion_gate, dim=0)
            out["logit"] = sum(wi * m for wi, m in zip(w, members))
        else:
            out["logit"] = fusion_logit
        return out

    # ---- transfer-learning helpers (same phases as the spatial trainer) -----

    def freeze_backbone(self) -> None:
        self.spatial.freeze_backbone()

    def unfreeze_top_blocks(self, n_blocks: int) -> None:
        self.spatial.unfreeze_top_blocks(n_blocks)

    def backbone_trainable_params(self):
        return self.spatial.backbone_trainable_params()

    def head_params(self):
        """All non-backbone params: heads, ConvLSTM, optional branches, fusion, gate."""
        params = list(self.spatial.head.parameters()) + list(self.temporal.parameters())
        if self.use_frequency:
            params += list(self.frequency.parameters())
        if self.use_motion:
            params += list(self.motion.parameters())
        params += list(self.fusion.parameters())
        if self.use_logit_fusion:
            params.append(self.fusion_gate)
        return params


def build_model(cfg: dict) -> nn.Module:
    """Build 'hybrid' (ECNetHybrid) or 'spatial' (ECNetModel) from config."""
    arch = str(cfg["model"].get("arch", "spatial")).lower()
    if arch == "hybrid":
        return ECNetHybrid(cfg)
    return ECNetModel(cfg)
