import type { VideoSegment } from "../types";
import type { LinkMeta } from "./realBackend";

/** What the picker splits: a local file, or a link known only by its metadata. */
export type PickSource = { kind: "file"; file: File } | { kind: "link"; url: string; meta: LinkMeta };

/** One analysis scores at most this much video; the server enforces it too. */
export const SEGMENT_SECONDS = 60;
/** Container durations wobble by fractions of a second, so a file this close
 *  to the limit is scored whole instead of offering a one-second part. */
const SLACK_SECONDS = 1;

export interface SegmentChoice {
  start: number;
  end: number;
}

export function needsSegment(duration: number | null): duration is number {
  return duration !== null && Number.isFinite(duration) && duration > SEGMENT_SECONDS + SLACK_SECONDS;
}

/** Back-to-back one-minute parts; the last one holds the remainder. */
export function splitIntoSegments(duration: number): SegmentChoice[] {
  const parts: SegmentChoice[] = [];
  for (let start = 0; start < duration - SLACK_SECONDS; start += SEGMENT_SECONDS) {
    parts.push({ start, end: Math.min(start + SEGMENT_SECONDS, duration) });
  }
  return parts;
}

/** 83.4 -> "1:23", 3725 -> "1:02:05". Floors, so a range never claims a second it lacks. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds + 1e-6));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function formatSpan(seg: SegmentChoice): string {
  return `${formatClock(seg.start)}–${formatClock(seg.end)}`;
}

/** True when the segment left part of the file unscored, i.e. worth labelling. */
export function isPartial(seg: VideoSegment | null | undefined): seg is VideoSegment {
  if (!seg) return false;
  return seg.sourceDuration === null || seg.sourceDuration - (seg.end - seg.start) > SLACK_SECONDS;
}

/** timeupdate body: keeps a muted preview inside the part, wrapping to its start. */
export function keepInside(video: HTMLVideoElement, seg: SegmentChoice | null | undefined): void {
  if (!seg) return;
  const t = video.currentTime;
  if (t >= seg.end - 0.05 || t < seg.start - 0.5) video.currentTime = seg.start;
}

/** "2:00–3:00 of 5:43", or without the total when the server could not read it. */
export function segmentLabel(seg: VideoSegment): string {
  const total = seg.sourceDuration !== null ? ` of ${formatClock(seg.sourceDuration)}` : "";
  return `${formatSpan(seg)}${total}`;
}
