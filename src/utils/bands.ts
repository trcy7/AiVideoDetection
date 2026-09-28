import type { Verdict } from "../types";

/** The deployed operating point: real <= 75 | uncertain | AI >= 80.
 *
 *  Server results carry their own `bands`, so this is the fallback for mock
 *  runs and for history saved before the server sent them. It must stay in
 *  step with the backend -- REAL_BELOW/FAKE_ABOVE in training/kaggle_serve.py
 *  and ECNET_REAL_BELOW/ECNET_FAKE_ABOVE in the Dockerfile. */
export const DEFAULT_BANDS = { realBelow: 75, fakeAbove: 80 };

/** The same rule the server applies, boundaries included on both ends: a score
 *  of exactly 75 is Real and exactly 80 is AI Generated. */
export function verdictFor(
  score: number,
  bands: { realBelow: number; fakeAbove: number } = DEFAULT_BANDS,
): Verdict {
  if (score <= bands.realBelow) return "real";
  if (score >= bands.fakeAbove) return "fake";
  return "uncertain";
}
