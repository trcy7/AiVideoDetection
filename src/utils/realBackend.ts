import type { BranchScores, HeatmapFrame, Verdict } from "../types";

/** Set VITE_USE_REAL_BACKEND=true in .env.local to call a real trained
 *  model (via training/src/server.py) instead of the built-in mock. */
export const USE_REAL_BACKEND = import.meta.env.VITE_USE_REAL_BACKEND === "true";
export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8000";

/** ngrok's free tier answers anything browser-shaped with an HTML interstitial
 *  instead of the real response, and that reply carries no CORS headers -- so
 *  it surfaces as an opaque network failure, not a readable error. This header
 *  opts out of it. Inert against any non-ngrok backend, so it is sent always. */
const BACKEND_HEADERS: Record<string, string> = {
  "ngrok-skip-browser-warning": "true",
};

/** Shape returned by POST /analyze — matches inference.py's contract
 *  plus the server-added modelVersion label. */
export interface BackendAnalysis {
  fileName: string;
  fakeScore: number;
  verdict: Verdict;
  confidence: number;
  /** Calibrated verdict thresholds baked into the checkpoint (optional for
   *  older servers that predate the field). */
  bands?: { realBelow: number; fakeAbove: number };
  branchScores: BranchScores;
  frames: HeatmapFrame[];
  modelVersion: string;
  /** Audit-trail row id; null when the server runs without storage. */
  analysisId?: string | null;
}

export type FeedbackLabel = "real" | "ai_generated" | "unsure";

/** Report what the clip actually was, building a real-world labeled set. */
export async function sendFeedback(
  analysisId: string,
  actualLabel: FeedbackLabel,
  note?: string,
): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/feedback`, {
    method: "POST",
    headers: { ...BACKEND_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ analysisId, actualLabel, note }),
  });
  if (!res.ok) throw new Error(`Feedback failed (${res.status})`);
}

/** Older/stale servers appended the architecture to the label
 *  ("ECNet-7 · ECNet-hybrid-tf_efficientnet_b4_ns"). Keep only the checkpoint
 *  name — the part before the middot — so the UI + report show "ECNet-7". */
export function cleanModelVersion(v: string): string {
  return v.split("·")[0].trim() || v;
}

export async function analyzeWithBackend(file: File): Promise<BackendAnalysis> {
  const form = new FormData();
  form.append("video", file, file.name);

  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/analyze`, {
      method: "POST",
      body: form,
      headers: BACKEND_HEADERS,
    });
  } catch {
    throw new Error(
      `Can't reach the inference server at ${BACKEND_URL}. ` +
        `The backend session may have ended -- restart it and try again.`,
    );
  }

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail ?? detail;
    } catch {
      /* non-JSON error body — keep statusText */
    }
    throw new Error(`Analysis failed (${res.status}): ${detail}`);
  }

  const data = (await res.json()) as BackendAnalysis;
  if (typeof data.modelVersion === "string") {
    data.modelVersion = cleanModelVersion(data.modelVersion);
  }
  return data;
}
