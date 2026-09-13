export type Verdict = "real" | "fake" | "uncertain";

/** Per-branch evidence scores, 0–100. Each optional branch is null unless the
 *  loaded checkpoint actually has it:
 *   - spatial      : EfficientNet per-frame texture (always present for hybrid)
 *   - opticalFlow  : ConvLSTM temporal branch (motion dynamics over features)
 *   - frequency    : FFT spectral branch (generator fingerprints)
 *   - motion       : temporal-residual branch (frame-to-frame motion incoherence)
 *  Older persisted history items may omit newer slots; the UI renders each only
 *  when non-null. */
export interface BranchScores {
  spatial: number;
  frequency: number | null;
  opticalFlow: number | null;
  motion?: number | null;
}

/** One suspicious region on a frame, in normalized (0–1) coordinates. */
export interface HeatmapBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0–1, how strongly the model flagged this region. */
  intensity: number;
}

export interface HeatmapFrame {
  /** 0-based index within the sampled frames. */
  index: number;
  /** Timestamp in the source video, seconds. */
  time: number;
  boxes: HeatmapBox[];
}

/** A rendered still for the PDF report: a JPEG data-URL (GradCAM baked in) with
 *  a short caption. */
export interface ReportFrame {
  dataUrl: string;
  caption: string;
}

/** One forensic signal shown as a metric card in the results view. */
export interface Indicator {
  id: string;
  label: string;
  /** 0–100; higher = stronger evidence of manipulation for this signal. */
  value: number;
  status: "consistent" | "suspicious" | "anomalous";
  description: string;
}

export interface AnalysisResult {
  fileName: string;
  verdict: Verdict;
  /** Confidence in the verdict, 0–100. */
  confidence: number;
  /** Position on the real→fake axis, 0 = certainly real, 100 = certainly fake. */
  fakeScore: number;
  /** Calibrated verdict thresholds from the model checkpoint: verdict is
   *  "real" below realBelow, "fake" above fakeAbove, "uncertain" between.
   *  Absent for older/mock results — UI falls back to 35/65. */
  bands?: { realBelow: number; fakeAbove: number };
  branchScores: BranchScores;
  indicators: Indicator[];
  frames: HeatmapFrame[];
  analyzedAt: string;
  /** Wall-clock analysis time in ms (measured from the flow, not mocked). */
  processingMs: number;
  modelVersion: string;
  reportUrl: string;
  /** Server audit-trail id; enables ground-truth feedback. Absent for mock runs. */
  analysisId?: string | null;
}

/** A persisted past analysis (localStorage). Blob URLs are rebuilt on restore. */
export interface HistoryItem {
  id: string;
  savedAt: string;
  /** JPEG data-URL captured from the analyzed video; null if capture failed. */
  thumbnail: string | null;
  fileSize: number;
  metadata: VideoMetadata;
  result: Omit<AnalysisResult, "reportUrl">;
}

export interface VideoMetadata {
  /** Seconds; null until known. */
  duration: number | null;
  width: number | null;
  height: number | null;
  /** Frames per second; null until estimated. */
  frameRate: number | null;
  codec: string | null;
}

export const EMPTY_METADATA: VideoMetadata = {
  duration: null,
  width: null,
  height: null,
  frameRate: null,
  codec: null,
};
