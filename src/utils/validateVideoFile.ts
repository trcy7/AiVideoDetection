export const MAX_DURATION_SECONDS = 60; // 1 minute — the user-facing limit
export const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024; // silent backstop only

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
      return { valid: false, error: "That's an image. This tool analyses video — pick a clip instead." };
    }
    if (file.type.startsWith("audio/") || AUDIO_EXTENSIONS.includes(extension)) {
      return { valid: false, error: "That's an audio file. This tool needs video frames to analyse." };
    }
    return {
      valid: false,
      error: `Unsupported file type "${extension || file.type || "unknown"}". Accepted formats: ${ACCEPTED_EXTENSIONS.join(", ")}.`,
    };
  }

  if (file.size === 0) {
    return { valid: false, error: "This file is empty." };
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    const maxMb = MAX_FILE_SIZE_BYTES / (1024 * 1024);
    const fileMb = (file.size / (1024 * 1024)).toFixed(1);
    return {
      valid: false,
      error: `File is too large (${fileMb} MB). Maximum allowed size is ${maxMb} MB.`,
    };
  }

  return { valid: true };
}

/** Async: reject clips longer than 1 minute. Reads only metadata. If the
 *  browser can't decode it, we allow it through (the server validates too). */
export function checkVideoDuration(file: File): Promise<ValidationResult> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    const done = (result: ValidationResult) => {
      URL.revokeObjectURL(url);
      resolve(result);
    };
    video.onloadedmetadata = () => {
      const d = video.duration;
      if (Number.isFinite(d) && d > MAX_DURATION_SECONDS) {
        done({
          valid: false,
          error: `That video is ${Math.round(d)}s. Maximum length is ${MAX_DURATION_SECONDS}s (1 minute).`,
        });
      } else {
        done({ valid: true });
      }
    };
    video.onerror = () => done({ valid: true });
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
