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
      description: "Reads each frame whole for generator artifacts — sliding textures, impossible detail, lighting that breaks.",
    },
    {
      id: "temporal",
      name: "Temporal",
      model: "ConvLSTM",
      value: scores.opticalFlow,
      description: "Tracks how features evolve across the clip, catching flicker, drift and objects that morph over time.",
    },
  ];
  if (scores.frequency != null) {
    rows.push({
      id: "frequency",
      name: "Frequency",
      model: "FFT",
      value: scores.frequency,
      description: "Reads the frame's frequency spectrum for the periodic fingerprints a generator's upsampling leaves behind.",
    });
  }
  return rows;
}
