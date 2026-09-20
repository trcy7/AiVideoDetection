import { useCallback, useEffect, useRef, useState } from "react";
import type { HeatmapFrame } from "../../types";
import "./HeatmapViewer.css";

interface HeatmapViewerProps {
  frames: HeatmapFrame[];
  /** Object URL of the uploaded video; frames are drawn from it via canvas. */
  videoUrl: string | null;
  /** Saved still frame. Used as the heatmap background when the video can't be
   *  restored (old history item, >80 MB, private mode) so the flagged-region
   *  boxes still overlay a real frame instead of a blank placeholder. */
  thumbnail?: string | null;
}

type DecodeState = "loading" | "ok" | "error";

export function HeatmapViewer({ frames, videoUrl, thumbnail }: HeatmapViewerProps) {
  const [frameIndex, setFrameIndex] = useState(0);
  const [opacity, setOpacity] = useState(70);
  const [decode, setDecode] = useState<DecodeState>(videoUrl ? "loading" : "error");
  // Pixel size of the letterboxed video area inside the stage. Computed in
  // JS from the canvas's intrinsic dimensions — CSS percentage tricks inside
  // aspect-ratio boxes resolve inconsistently, and the overlay boxes must
  // track the *rendered video*, not the stage.
  const [fit, setFit] = useState<{ w: number; h: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  // Server-rendered stills are authoritative when present: they always draw,
  // whereas the video path needs the browser to decode the source. Older
  // results carry no stills, so those still scrub over every frame.
  const viewFrames = frames.some((f) => f.image) ? frames.filter((f) => f.image) : frames;
  const frame = viewFrames[Math.min(frameIndex, viewFrames.length - 1)];

  const updateFit = useCallback(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas || !canvas.width || !canvas.height) return;
    const scale = Math.min(
      stage.clientWidth / canvas.width,
      stage.clientHeight / canvas.height,
    );
    setFit({
      w: Math.round(canvas.width * scale),
      h: Math.round(canvas.height * scale),
    });
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(updateFit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [updateFit]);

  // Paint the server-rendered still for this frame.
  const drawFrameImage = useCallback((src: string) => {
    const img = new Image();
    img.onload = () => {
      const c = canvasRef.current;
      if (!c) return;
      c.width = img.naturalWidth || 640;
      c.height = img.naturalHeight || 360;
      c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
      updateFit();
    };
    img.src = src;
  }, [updateFit]);

  const drawCurrentFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.videoWidth === 0) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    updateFit();
  }, [updateFit]);

  // Stylized "no signal" frame when the browser can't decode the file:
  // grid, wireframe head, HUD corners — consistent with the hero graphic.
  const drawPlaceholder = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const gradient = ctx.createLinearGradient(0, 0, 640, 360);
    gradient.addColorStop(0, "#121a28");
    gradient.addColorStop(1, "#0a0e15");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 640, 360);

    ctx.strokeStyle = "rgba(139,150,168,0.12)";
    ctx.lineWidth = 1;
    for (let x = 40; x < 640; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 360);
      ctx.stroke();
    }
    for (let y = 40; y < 360; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(640, y);
      ctx.stroke();
    }

    // wireframe head + shoulders
    ctx.strokeStyle = "rgba(139,150,168,0.5)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(320, 150, 62, 78, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(210, 360);
    ctx.quadraticCurveTo(230, 250, 320, 244);
    ctx.quadraticCurveTo(410, 250, 430, 360);
    ctx.stroke();

    // HUD corner brackets
    ctx.strokeStyle = "rgba(52,211,153,0.8)";
    ctx.lineWidth = 2.5;
    const corner = (x: number, y: number, dx: number, dy: number) => {
      ctx.beginPath();
      ctx.moveTo(x + dx * 26, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + dy * 26);
      ctx.stroke();
    };
    corner(16, 16, 1, 1);
    corner(624, 16, -1, 1);
    corner(624, 344, -1, -1);
    corner(16, 344, 1, -1);

    ctx.fillStyle = "rgba(232,237,244,0.75)";
    ctx.font = "600 15px 'JetBrains Mono', Consolas, monospace";
    ctx.textAlign = "center";
    ctx.fillText("FRAME PREVIEW UNAVAILABLE", 320, 326);
    updateFit();
  }, [updateFit]);

  // Paint the saved still onto the canvas as the heatmap background. Returns
  // false (so the caller can fall back to the wireframe placeholder) only when
  // there is no thumbnail to draw.
  const drawThumbnail = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !thumbnail) return false;
    const img = new Image();
    img.onload = () => {
      const c = canvasRef.current;
      if (!c) return;
      c.width = img.naturalWidth || 640;
      c.height = img.naturalHeight || 360;
      c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
      updateFit();
    };
    img.onerror = () => drawPlaceholder();
    img.src = thumbnail;
    return true;
  }, [thumbnail, updateFit, drawPlaceholder]);

  // A restored history item's video arrives late (null -> url) or may never
  // arrive; the useState initializer only runs once, so re-drive decode
  // whenever videoUrl changes.
  useEffect(() => {
    setDecode(videoUrl ? "loading" : "error");
  }, [videoUrl]);

  // No decodable video -> show the saved still (boxes still overlay it), or
  // the wireframe placeholder if there's no thumbnail either.
  useEffect(() => {
    if (decode !== "error" || frame?.image) return;   // a still already covers it
    if (!drawThumbnail()) drawPlaceholder();
  }, [decode, drawThumbnail, drawPlaceholder, frame]);

  // Seek the hidden video to the selected frame's timestamp; the `seeked`
  // event fires once the frame is decoded and ready to paint.
  useEffect(() => {
    if (frame?.image) {
      drawFrameImage(frame.image);
      return;
    }
    const video = videoRef.current;
    if (!video || decode !== "ok" || !frame) return;
    const end = video.duration && isFinite(video.duration) ? video.duration - 0.05 : undefined;
    const target = Math.max(0, end !== undefined ? Math.min(frame.time, end) : frame.time);
    if (Math.abs(video.currentTime - target) < 0.01) {
      drawCurrentFrame();
      return;
    }
    video.currentTime = target;
  }, [frame, decode, drawCurrentFrame, drawFrameImage]);

  const step = (delta: number) => {
    setFrameIndex((i) => Math.min(viewFrames.length - 1, Math.max(0, i + delta)));
  };

  return (
    <div className="heatmap">
      <div className="heatmap__stage" ref={stageRef}>
        {videoUrl && (
          <video
            ref={videoRef}
            src={videoUrl}
            muted
            playsInline
            preload="auto"
            className="heatmap__hidden-video"
            onLoadedData={() => {
              setDecode("ok");
              drawCurrentFrame();
            }}
            onSeeked={drawCurrentFrame}
            onError={() => setDecode("error")}
            aria-hidden="true"
            tabIndex={-1}
          />
        )}
        {/* Sized to the letterboxed video area (JS-computed), so the
            overlay's percentage coordinates always map to the rendered video
            — portrait/square footage letterboxes instead of cropping. */}
        <div
          className="heatmap__content"
          style={fit ? { width: `${fit.w}px`, height: `${fit.h}px` } : undefined}
        >
          <canvas
            ref={canvasRef}
            className="heatmap__canvas"
            role="img"
            aria-label={`Video frame ${frame.index + 1} of ${viewFrames.length} with ${frame.boxes.length} suspicious region${frame.boxes.length === 1 ? "" : "s"} highlighted`}
          />
          <div
            className="heatmap__overlay"
            style={{ opacity: opacity / 100 }}
            aria-hidden="true"
          >
            {frame.boxes.map((box, i) => (
              <div
                key={i}
                className="heatmap__box"
                style={{
                  left: `${box.x * 100}%`,
                  top: `${box.y * 100}%`,
                  width: `${box.w * 100}%`,
                  height: `${box.h * 100}%`,
                  backgroundColor: `color-mix(in srgb, var(--color-fake-mark) ${Math.round(box.intensity * 32)}%, transparent)`,
                }}
              />
            ))}
          </div>
          <span className="heatmap__frame-tag">
            Frame {frameIndex + 1} / {viewFrames.length} · {frame.time.toFixed(2)}s
          </span>
          {frame.boxes.length === 0 && (
            <span className="heatmap__clean-tag">No suspicious regions on this frame</span>
          )}
        </div>
      </div>

      <div className="heatmap__controls">
        <div className="heatmap__row">
          <button
            type="button"
            className="heatmap__step"
            onClick={() => step(-1)}
            disabled={frameIndex === 0}
            aria-label="Previous frame"
          >
            ‹
          </button>
          <label className="heatmap__field">
            <span className="heatmap__field-label">
              Frame <strong>{frameIndex + 1}</strong> / {viewFrames.length}
            </span>
            <input
              type="range"
              min={0}
              max={viewFrames.length - 1}
              step={1}
              value={frameIndex}
              onChange={(e) => setFrameIndex(Number(e.target.value))}
              aria-label="Frame scrubber"
            />
          </label>
          <button
            type="button"
            className="heatmap__step"
            onClick={() => step(1)}
            disabled={frameIndex === viewFrames.length - 1}
            aria-label="Next frame"
          >
            ›
          </button>
        </div>

        <div className="heatmap__row">
          <label className="heatmap__field heatmap__field--opacity">
            <span className="heatmap__field-label">
              Overlay opacity <strong>{opacity}%</strong>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
              aria-label="Heatmap overlay opacity"
            />
          </label>
        </div>
      </div>
    </div>
  );
}
