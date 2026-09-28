import type { BranchScores } from "../../types";

export interface BranchRow {
  id: string;
  name: string;
  model: string;
  /** 0-100, or null when the loaded checkpoint has no such branch. */
  value: number | null;
  description: string;
}

/** The branches the results UI reports, in reading order. Temporal rides in the
 *  backend's opticalFlow slot. Frequency appears only for checkpoints that have
 *  it, and the motion branch is not surfaced. */
export function branchList(scores: BranchScores): BranchRow[] {
  const rows: BranchRow[] = [
    {
      id: "spatial",
      name: "Spatial",
      model: "EfficientNet-B4",
      value: scores.spatial,
      description: "Per-frame texture, structure and lighting artifacts.",
    },
    {
      id: "temporal",
      name: "Temporal",
      model: "ConvLSTM",
      value: scores.opticalFlow,
      description: "Frame-to-frame consistency across each 16-frame window.",
    },
  ];
  if (scores.frequency != null) {
    rows.push({
      id: "frequency",
      name: "Frequency",
      model: "FFT",
      value: scores.frequency,
      description: "Periodic spectral artifacts from generator upsampling.",
    });
  }
  return rows;
}
