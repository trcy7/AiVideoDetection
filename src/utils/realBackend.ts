import type { BranchScores, HeatmapFrame, Verdict, VideoSegment, WindowScore } from "../types";

/** Set VITE_USE_REAL_BACKEND=true in .env.local to call a real trained
 *  model (via training/src/server.py) instead of the built-in mock. */
export const USE_REAL_BACKEND = import.meta.env.VITE_USE_REAL_BACKEND === "true";
export const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8000")
  .trim()
  .replace(/\/+$/, "");

/** A VITE_BACKEND_URL with no scheme is a RELATIVE path: the browser resolves it
 *  against this site's own origin, the SPA rewrite in vercel.json turns it into
 *  index.html, and static hosting answers POST with 405. That reads as a broken
 *  backend when it is really a misconfigured env var, so name it precisely. */
const BACKEND_URL_ERROR =
  USE_REAL_BACKEND && !/^https?:\/\//i.test(BACKEND_URL)
    ? `Configuration error: VITE_BACKEND_URL must be an absolute URL ` +
      `beginning with https:// (received "${BACKEND_URL}").`
    : null;

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
  /** Per-window scores behind fakeScore; absent on servers predating them. */
  windows?: WindowScore[];
  /** The part of the upload that was scored; absent when it was all of it,
   *  and on servers predating segments (which score the whole file). */
  segment?: VideoSegment;
  /** The link, for link analyses. */
  sourceUrl?: string;
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
  if (BACKEND_URL_ERROR) throw new Error(BACKEND_URL_ERROR);
  const res = await fetch(`${BACKEND_URL}/feedback`, {
    method: "POST",
    headers: { ...BACKEND_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ analysisId, actualLabel, note }),
  });
  if (!res.ok) throw new Error(`Feedback could not be submitted (${res.status}).`);
}

/** Older/stale servers appended the architecture to the label
 *  ("ECNet-7 · ECNet-hybrid-tf_efficientnet_b4_ns"). Keep only the checkpoint
 *  name — the part before the middot — so the UI + report show "ECNet-7". */
export function cleanModelVersion(v: string): string {
  return v.split("·")[0].trim() || v;
}

/** What a link is, before it has been analysed. */
export interface LinkMeta {
  title: string | null;
  uploader: string | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  filesize: number | null;
  thumbnail: string | null;
  extractor: string | null;
}

/** Title/poster for a pasted link, so the scanning view can name what it is
 *  working on instead of echoing the URL. Purely cosmetic -- resolves to null
 *  on any failure rather than disturbing the analysis it runs alongside. */
export async function resolveUrlMeta(url: string): Promise<LinkMeta | null> {
  if (BACKEND_URL_ERROR) return null;
  try {
    const res = await fetch(`${BACKEND_URL}/resolve-url`, {
      method: "POST",
      headers: { ...BACKEND_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) return null;
    return (await res.json()) as LinkMeta;
  } catch {
    return null;
  }
}

/** A few seconds of low-res video for the scanning view, from `start` on. Returns
 *  the blob, not an object URL: the caller shows it AND persists it as the
 *  history clip for a link, which has no local file to store. `start` is where
 *  the clip begins in the source (0 from servers that cannot cut). Null when the
 *  server declines (204) or anything fails -- the viewport then keeps its poster. */
export async function fetchPreviewClip(
  url: string,
  start = 0,
): Promise<{ blob: Blob; start: number } | null> {
  if (BACKEND_URL_ERROR) return null;
  try {
    const res = await fetch(`${BACKEND_URL}/preview-url`, {
      method: "POST",
      headers: { ...BACKEND_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ url, start }),
    });
    if (!res.ok || res.status === 204) return null;
    const blob = await res.blob();
    const at = Number.parseFloat(res.headers.get("X-Clip-Start") ?? "0");
    return blob.size > 0 ? { blob, start: Number.isFinite(at) ? at : 0 } : null;
  } catch {
    return null;
  }
}

/** Analyze a public video link. The server fetches only the chosen part (by
 *  default the first minute), scores it, and deletes the download -- nothing
 *  is uploaded from here. */
export async function analyzeUrlWithBackend(
  url: string,
  segment: { start: number; end: number } | null = null,
  signal?: AbortSignal,
): Promise<BackendAnalysis> {
  if (BACKEND_URL_ERROR) throw new Error(BACKEND_URL_ERROR);

  const part = segment
    ? { start: +segment.start.toFixed(3), duration: +(segment.end - segment.start).toFixed(3) }
    : {};
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/analyze-url`, {
      method: "POST",
      headers: { ...BACKEND_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ url, ...part }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error(
      `Inference server unreachable at ${BACKEND_URL}. ` +
        `The backend may be offline.`,
    );
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  const data = (await res.json()) as BackendAnalysis;
  if (typeof data.modelVersion === "string") {
    data.modelVersion = cleanModelVersion(data.modelVersion);
  }
  return data;
}

export async function analyzeWithBackend(
  file: File,
  segment: { start: number; end: number } | null = null,
  signal?: AbortSignal,
): Promise<BackendAnalysis> {
  if (BACKEND_URL_ERROR) throw new Error(BACKEND_URL_ERROR);

  const form = new FormData();
  form.append("video", file, file.name);
  if (segment) {
    // the server reads just this span from the original file
    form.append("start", segment.start.toFixed(3));
    form.append("duration", (segment.end - segment.start).toFixed(3));
  }

  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/analyze`, {
      method: "POST",
      body: form,
      headers: BACKEND_HEADERS,
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error(
      `Inference server unreachable at ${BACKEND_URL}. ` +
        `The backend may be offline.`,
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
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      // ngrok closes the request at 300 s (ERR_NGROK_3004). The server is
      // usually alive and still working -- it is the analysis that overran,
      // which is what a CPU-only session looks like from out here.
      detail =
        "analysis exceeded the 5-minute request limit.";
    }
    if (res.status === 405) {
      // Static hosts reject POST; the request never reached the backend.
      detail =
        `the request reached ${BACKEND_URL}, which does not accept POST. ` +
        `VITE_BACKEND_URL may be pointing at the frontend rather than the API.`;
    }
    // 422 is a refused file ("too short", "a picture"): already a full sentence
    if (res.status === 422 && typeof detail === "string") throw new Error(detail);
    throw new Error(`Analysis failed (${res.status}): ${detail}`);
  }

  const data = (await res.json()) as BackendAnalysis;
  if (typeof data.modelVersion === "string") {
    data.modelVersion = cleanModelVersion(data.modelVersion);
  }
  return data;
}
