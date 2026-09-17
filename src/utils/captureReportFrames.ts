import type { HeatmapBox, HeatmapFrame, ReportFrame } from "../types";

const FRAME_WIDTH = 480;

function scoreOf(f: HeatmapFrame): number {
  return f.boxes.reduce((s, b) => s + b.intensity, 0);
}

/** Chooses which frames to show: the highest-scoring flagged frames (spread out
 *  in time), or evenly-spaced samples when nothing was flagged. */
function pickFrames(frames: HeatmapFrame[], count: number): Array<{ frame: HeatmapFrame; caption: string }> {
  if (!frames.length) return [];
  const duration = frames[frames.length - 1].time || 1;
  const minGap = duration * 0.12;

  const spread = (pool: HeatmapFrame[], flagged: boolean) => {
    const chosen: HeatmapFrame[] = [];
    for (const f of pool) {
      if (chosen.every((c) => Math.abs(c.time - f.time) >= minGap)) chosen.push(f);
      if (chosen.length >= count) break;
    }
    return chosen.map((f) => ({
      frame: f,
      caption: flagged
        ? `${f.boxes.length} flagged region${f.boxes.length === 1 ? "" : "s"} - ${f.time.toFixed(1)}s`
        : `Frame - ${f.time.toFixed(1)}s`,
    }));
  };

  const flagged = frames.filter((f) => f.boxes.length > 0);
  if (flagged.length) {
    const picks = spread([...flagged].sort((a, b) => scoreOf(b) - scoreOf(a)), true);
    if (picks.length) return picks.slice(0, count);
  }

  const step = Math.max(1, Math.floor(frames.length / (count + 1)));
  const sample: HeatmapFrame[] = [];
  for (let k = 1; k <= count; k++) sample.push(frames[Math.min(frames.length - 1, k * step)]);
  return spread(sample, false);
}

function drawBoxes(ctx: CanvasRenderingContext2D, boxes: HeatmapBox[], cw: number, ch: number) {
  for (const b of boxes) {
    const x = b.x * cw;
    const y = b.y * ch;
    const w = b.w * cw;
    const h = b.h * ch;
    ctx.fillStyle = `rgba(239,68,68,${Math.min(0.4, 0.16 + b.intensity * 0.3)})`;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "rgba(239,68,68,0.95)";
    ctx.lineWidth = Math.max(1.5, cw * 0.005);
    ctx.strokeRect(x, y, w, h);
  }
}

/** Renders up to `count` report stills from a video: seeks to the chosen frames,
 *  draws the GradCAM boxes onto each, and returns them as JPEG data-URLs.
 *  Resolves to [] on any failure — the report just omits the images. */
export function captureReportFrames(
  videoUrl: string,
  frames: HeatmapFrame[],
  count = 2,
): Promise<ReportFrame[]> {
  const picks = pickFrames(frames, count);
  if (!picks.length) return Promise.resolve([]);

  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = videoUrl;

    const out: ReportFrame[] = [];
    const timeout = setTimeout(() => finish(), 8000);
    const finish = () => {
      clearTimeout(timeout);
      video.removeAttribute("src");
      resolve(out);
    };

    video.addEventListener("error", finish, { once: true });
    video.addEventListener("loadeddata", () => {
      const scale = Math.min(1, FRAME_WIDTH / (video.videoWidth || FRAME_WIDTH));
      const cw = Math.max(1, Math.round(video.videoWidth * scale));
      const ch = Math.max(1, Math.round(video.videoHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext("2d");
      if (!ctx) return finish();

      let i = 0;
      const next = () => {
        if (i >= picks.length) return finish();
        const pick = picks[i];
        const draw = () => {
          try {
            ctx.drawImage(video, 0, 0, cw, ch);
            drawBoxes(ctx, pick.frame.boxes, cw, ch);
            out.push({ dataUrl: canvas.toDataURL("image/jpeg", 0.75), caption: pick.caption });
          } catch {
            /* skip this frame */
          }
          i++;
          next();
        };
        // Seeking to where we already are fires no "seeked", and a target at or
        // past the end may never fire either -- both stall the chain until the
        // timeout, returning no images at all. Clamp, then short-circuit.
        const end = video.duration && isFinite(video.duration) ? video.duration - 0.05 : undefined;
        const target = Math.max(0, end !== undefined ? Math.min(pick.frame.time, end) : pick.frame.time);
        if (Math.abs(video.currentTime - target) < 0.01) return draw();
        video.addEventListener("seeked", draw, { once: true });
        video.currentTime = target;
      };
      next();
    }, { once: true });
  });
}
