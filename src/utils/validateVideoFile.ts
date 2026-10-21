export const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024; // silent backstop only

/** A clip must be LONGER than this; the server enforces it too. */
export const MIN_VIDEO_SECONDS = 2;

export const ACCEPTED_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "video/avi",
  "video/x-msvideo",
];

export const ACCEPTED_EXTENSIONS = [
  ".mp4",
  ".mov",
  ".webm",
  ".mkv",
  ".avi",
];

/** Named so the message can say what was actually dropped. "Unsupported file
 *  type .jpg" leaves the user guessing; "that is an image" does not. */
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".avif", ".svg"];
const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"];

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Browsers don't always populate `file.type` correctly (notably for .mkv),
 * so we fall back to checking the extension when the MIME type is missing
 * or unrecognized rather than rejecting the file outright.
 */
export function validateVideoFile(file: File): ValidationResult {
  const extension = file.name
    .slice(file.name.lastIndexOf("."))
    .toLowerCase();

  const typeOk =
    ACCEPTED_MIME_TYPES.includes(file.type) ||
    ACCEPTED_EXTENSIONS.includes(extension);

  if (!typeOk) {
    if (file.type.startsWith("image/") || IMAGE_EXTENSIONS.includes(extension)) {
      return { valid: false, error: "Image files are not supported. Select a video file." };
    }
    if (file.type.startsWith("audio/") || AUDIO_EXTENSIONS.includes(extension)) {
      return { valid: false, error: "Audio files are not supported. Select a video file." };
    }
    return {
      valid: false,
      error: `Unsupported format: ${extension || file.type || "unknown"}. Supported formats: ${ACCEPTED_EXTENSIONS.join(", ")}.`,
    };
  }

  if (file.size === 0) {
    return { valid: false, error: "File is empty." };
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    const maxMb = MAX_FILE_SIZE_BYTES / (1024 * 1024);
    const fileMb = (file.size / (1024 * 1024)).toFixed(1);
    return {
      valid: false,
      error: `File exceeds the ${maxMb} MB limit (${fileMb} MB).`,
    };
  }

  return { valid: true };
}

const UPLOAD_HINT = "Upload a video file (mp4, mov, webm, mkv or avi).";
// Laid out exactly like an mp4; only the brand says still or audio.
const IMAGE_BRANDS = ["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1", "miaf", "avif", "avis", "crx "];
const AUDIO_BRANDS = ["M4A ", "M4B ", "M4P ", "F4A ", "F4B "];

/** Same rules as the server's _sniff: the first bytes, not the name. */
function sniff(b: Uint8Array): "video" | "image" | "audio" | "other" {
  const text = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  const bytes = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  const box = text(4, 8);
  if (box === "ftyp") {
    const brand = text(8, 12);
    return IMAGE_BRANDS.includes(brand) ? "image" : AUDIO_BRANDS.includes(brand) ? "audio" : "video";
  }
  if (["moov", "mdat", "wide", "free", "skip", "pnot"].includes(box)) return "video"; // QuickTime, no ftyp
  if (bytes(0x1a, 0x45, 0xdf, 0xa3)) return "video"; // Matroska / WebM
  if (text(0, 4) === "RIFF") {
    const kind = text(8, 12);
    return kind === "AVI " ? "video" : kind === "WEBP" ? "image" : kind === "WAVE" ? "audio" : "other";
  }
  if (
    bytes(0xff, 0xd8, 0xff) || bytes(0x89, 0x50, 0x4e, 0x47) || text(0, 6) === "GIF87a" || text(0, 6) === "GIF89a" ||
    text(0, 2) === "BM" || bytes(0x49, 0x49, 0x2a, 0x00) || bytes(0x4d, 0x4d, 0x00, 0x2a) || text(0, 4) === "<svg"
  ) {
    return "image";
  }
  if (text(0, 3) === "ID3" || text(0, 4) === "fLaC" || (b[0] === 0xff && [0xfb, 0xf3, 0xf2, 0xf1, 0xf9].includes(b[1]))) {
    return "audio";
  }
  return "other";
}

/** Async: an error when the file's content is not a video, whatever its
 *  extension says (a photo renamed .mp4). Null when it looks like one. */
export async function sniffVideoFile(file: File): Promise<string | null> {
  let head: Uint8Array;
  try {
    head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  } catch {
    return null; // unreadable here; the server checks again
  }
  const kind = sniff(head);
  if (kind === "video") return null;
  const lead =
    kind === "image"
      ? "This file is a picture, not a video."
      : kind === "audio"
        ? "This file is audio, not a video."
        : "This file is not a video.";
  return `${lead} ${UPLOAD_HINT}`;
}

/** Worded like the server's, so the same rule reads the same either way. */
export function tooShortMessage(seconds: number, part = false): string {
  const secs = (v: number) => {
    const n = String(Number(v.toFixed(2)));
    return n === "1" ? "1 second" : `${n} seconds`;
  };
  return part
    ? `The part you picked is ${secs(seconds)} long. Pick a part longer than ${secs(MIN_VIDEO_SECONDS)}.`
    : `This video is ${secs(seconds)} long. Videos must be longer than ${secs(MIN_VIDEO_SECONDS)}.`;
}

/** Async: the clip's length in seconds, reading only metadata. Null when the
 *  browser can't decode it; the server still caps what it scores. */
export function probeVideoDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    let settled = false;
    const done = (d: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      resolve(d !== null && Number.isFinite(d) && d > 0 ? d : null);
    };
    const timer = setTimeout(() => done(null), 8000);
    video.onloadedmetadata = () => {
      if (Number.isFinite(video.duration)) return done(video.duration);
      // recorder WebM reports Infinity until its end is read; seeking far forces it
      video.ondurationchange = () => {
        if (Number.isFinite(video.duration)) done(video.duration);
      };
      video.currentTime = 1e101;
    };
    video.onerror = () => done(null);
    video.src = url;
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
