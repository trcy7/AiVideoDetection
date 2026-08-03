import type { VideoMetadata } from "../types";

/**
 * Codec detection without a parser library: container formats embed the
 * codec's four-character code (fourcc) as a plain byte string near the
 * start of the file, so scanning the first few MB finds it in practice.
 */
const FOURCC_LABELS: Array<[needle: string, label: string]> = [
  ["avc1", "H.264 / AVC"],
  ["avc3", "H.264 / AVC"],
  ["hvc1", "H.265 / HEVC"],
  ["hev1", "H.265 / HEVC"],
  ["av01", "AV1"],
  ["vp09", "VP9"],
  ["V_VP9", "VP9"],
  ["vp08", "VP8"],
  ["V_VP8", "VP8"],
  ["V_AV1", "AV1"],
  ["mp4v", "MPEG-4 Visual"],
];

async function sniffCodec(file: File): Promise<string | null> {
  try {
    const head = await file.slice(0, 4 * 1024 * 1024).arrayBuffer();
    const text = new TextDecoder("latin1").decode(new Uint8Array(head));
    for (const [needle, label] of FOURCC_LABELS) {
      if (text.includes(needle)) return label;
    }
  } catch {
    // fall through to MIME-based guess
  }
  if (file.type === "video/webm") return "WebM (unknown codec)";
  if (file.type === "video/mp4") return "MP4 (unknown codec)";
  return null;
}

/**
 * Extracts duration, dimensions, and codec from a video file entirely
 * client-side. Fields arrive at different speeds, so results stream in
 * through `onUpdate` patches and the UI shows "—" for anything unknown.
 *
 * Frame rate is NOT estimated here: browsers throttle decoding for
 * off-screen videos, which silently corrupts the measurement. Use
 * `estimateFrameRate` on a video element that is actually visible
 * (the metadata panel's preview thumbnail).
 *
 * Returns a cleanup function that cancels pending work.
 */
export function extractVideoMetadata(
  file: File,
  onUpdate: (patch: Partial<VideoMetadata>) => void,
): () => void {
  let cancelled = false;
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.src = url;

  sniffCodec(file).then((codec) => {
    if (!cancelled && codec) onUpdate({ codec });
  });

  const reportDimensions = () => {
    if (cancelled || !video.videoWidth) return;
    onUpdate({ width: video.videoWidth, height: video.videoHeight });
  };

  // Streamed recordings (e.g. MediaRecorder output) report their dimensions
  // slightly after loadedmetadata, via a `resize` event.
  video.addEventListener("resize", reportDimensions);

  video.addEventListener("durationchange", () => {
    if (cancelled) return;
    if (Number.isFinite(video.duration) && video.duration > 0) {
      onUpdate({ duration: video.duration });
    }
  });

  video.addEventListener("loadedmetadata", () => {
    if (cancelled) return;
    reportDimensions();
    if (Number.isFinite(video.duration)) {
      onUpdate({ duration: video.duration });
    } else {
      // Streamed recordings have no duration in the header and report
      // Infinity. Seeking far past the end forces the browser to scan the
      // file and emit `durationchange` with the real value.
      video.currentTime = 1e10;
    }
  });

  return () => {
    cancelled = true;
    video.pause();
    video.removeAttribute("src");
    URL.revokeObjectURL(url);
  };
}

/**
 * Estimates frames-per-second by briefly playing `video` muted and counting
 * decoded frames via getVideoPlaybackQuality(). The element must be visible
 * on screen — browsers throttle decoding of hidden videos, which would make
 * the count meaningless. Calls `onFrameRate` once, then pauses the video.
 *
 * Returns a cleanup function that cancels the measurement.
 */
export function estimateFrameRate(
  video: HTMLVideoElement,
  onFrameRate: (fps: number) => void,
): () => void {
  let cancelled = false;
  let poll: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (poll !== null) clearInterval(poll);
    poll = null;
    video.pause();
  };

  const start = () => {
    if (cancelled) return;
    const q0 = video.getVideoPlaybackQuality().totalVideoFrames;
    const t0 = video.currentTime;

    const finish = () => {
      const elapsed = video.currentTime - t0;
      const frames = video.getVideoPlaybackQuality().totalVideoFrames - q0;
      stop();
      if (!cancelled && frames > 0 && elapsed > 0.2) {
        onFrameRate(Math.round(frames / elapsed));
      }
    };

    video.addEventListener("ended", finish, { once: true });
    video
      .play()
      .then(() => {
        poll = setInterval(() => {
          if (cancelled) {
            stop();
            return;
          }
          if (video.currentTime - t0 >= 1.2) finish();
        }, 100);
      })
      .catch(() => {
        /* autoplay blocked or undecodable — frame rate stays unknown */
      });
  };

  if (video.readyState >= 2) {
    start();
  } else {
    video.addEventListener("loadeddata", start, { once: true });
  }

  return () => {
    cancelled = true;
    stop();
  };
}

export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds - mins * 60;
  if (mins === 0) return `${secs.toFixed(1)}s`;
  return `${mins}m ${Math.round(secs)}s`;
}
