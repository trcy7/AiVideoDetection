import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { USE_REAL_BACKEND } from "../../utils/realBackend";
import { formatBytes } from "../../utils/validateVideoFile";
import {
  formatClock,
  formatSpan,
  keepInside,
  splitIntoSegments,
  type PickSource,
  type SegmentChoice,
} from "../../utils/segments";
import "./SegmentPicker.css";

interface SegmentPickerProps {
  /** A local file previews live; a link shows its poster (nothing is fetched yet). */
  source: PickSource;
  duration: number;
  /** Pre-selects this part when the picker is reopened. */
  initial?: SegmentChoice | null;
  onConfirm: (segment: SegmentChoice) => void;
  onCancel: () => void;
}

const THUMB_WIDTH = 240;
const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** One still per part, grabbed in order from a single hidden video. */
function usePartThumbs(url: string | null, parts: SegmentChoice[]) {
  const [thumbs, setThumbs] = useState<(string | null)[]>(() => parts.map(() => null));
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";

    const once = (event: string, ms: number) =>
      new Promise<boolean>((resolve) => {
        const ok = () => finish(true);
        const fail = () => finish(false);
        const timer = setTimeout(fail, ms);
        function finish(v: boolean) {
          clearTimeout(timer);
          video.removeEventListener(event, ok);
          video.removeEventListener("error", fail);
          resolve(v);
        }
        video.addEventListener(event, ok);
        video.addEventListener("error", fail);
      });

    void (async () => {
      const loaded = once("loadeddata", 8000);
      video.src = url;
      if (!(await loaded)) return setDone(true);
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      for (let i = 0; i < parts.length && !cancelled && ctx; i++) {
        const p = parts[i];
        const seeked = once("seeked", 5000);
        video.currentTime = p.start + (p.end - p.start) / 2;
        if (!(await seeked) || cancelled || !video.videoWidth) continue;
        const scale = Math.min(1, THUMB_WIDTH / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const shot = canvas.toDataURL("image/jpeg", 0.72);
          setThumbs((prev) => prev.map((t, j) => (j === i ? shot : t)));
        } catch {
          /* undecodable frame: the card keeps its placeholder */
        }
      }
      if (!cancelled) setDone(true);
    })();

    return () => {
      cancelled = true;
      video.removeAttribute("src");
      video.load();
    };
  }, [url, parts]);

  return { thumbs, done };
}

/** Pop-up for videos over a minute: the file or link is split into back-to-back
 *  one-minute parts and the user picks the one ECNet should analyze. */
export function SegmentPicker({ source, duration, initial, onConfirm, onCancel }: SegmentPickerProps) {
  const file = source.kind === "file" ? source.file : null;
  const meta = source.kind === "link" ? source.meta : null;
  const parts = useMemo(() => splitIntoSegments(duration), [duration]);
  const [sel, setSel] = useState(() => {
    const i = initial ? parts.findIndex((p) => Math.abs(p.start - initial.start) < 0.5) : -1;
    return Math.max(0, i);
  });
  const [url, setUrl] = useState<string | null>(null);
  const [autoPlay] = useState(() => !prefersReducedMotion());
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState(parts[0]?.start ?? 0);
  const { thumbs, done } = usePartThumbs(url, parts);

  const dialogRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const downOnBackdrop = useRef(false);
  const part = parts[sel];

  // created and revoked by the same effect: a URL made at render would be
  // revoked by the dev double-mount and leave the remount pointing at nothing
  useEffect(() => {
    if (!file) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  // page behind goes inert and stops scrolling; focus comes back on close
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const root = document.getElementById("root");
    const overflow = document.documentElement.style.overflow;
    root?.setAttribute("inert", "");
    document.documentElement.style.overflow = "hidden";
    dialogRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
    return () => {
      root?.removeAttribute("inert");
      document.documentElement.style.overflow = overflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  // the preview loops the selected part; `loop` brings the last part back round
  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    keepInside(v, part);
    setNow(v.currentTime);
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };

  const select = useCallback(
    (i: number, focus = false) => {
      const next = (i + parts.length) % parts.length;
      setSel(next);
      if (videoRef.current) videoRef.current.currentTime = parts[next].start;
      if (focus) itemRefs.current[next]?.focus();
      itemRefs.current[next]?.scrollIntoView({ block: "nearest" });
    },
    [parts],
  );

  const onPartsKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (e.key in moves) select(sel + moves[e.key], true);
    else if (e.key === "Home") select(0, true);
    else if (e.key === "End") select(parts.length - 1, true);
    else if (e.key === "Enter") onConfirm(part);
    else return;
    e.preventDefault();
  };

  const onDialogKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;
    const nodes = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onTimelineClick = (e: MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const t = ((e.clientX - box.left) / box.width) * duration;
    const i = parts.findIndex((p) => t >= p.start && t < p.end);
    select(i === -1 ? parts.length - 1 : i);
  };

  if (!part) return null;
  const span = formatSpan(part);
  const pct = (t: number) => `${(Math.min(Math.max(t, 0), duration) / duration) * 100}%`;

  return createPortal(
    <div
      className="segpick"
      onMouseDown={(e) => (downOnBackdrop.current = e.target === e.currentTarget)}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="segpick__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="segpick-title"
        aria-describedby="segpick-desc"
        tabIndex={-1}
        onKeyDown={onDialogKey}
      >
        <header className="segpick__head">
          <div className="segpick__heading">
            <p className="hud-label segpick__eyebrow">Long video · {formatClock(duration)}</p>
            <h2 id="segpick-title" className="segpick__title">
              Choose 1 minute to analyze
            </h2>
          </div>
          <button type="button" className="segpick__close" onClick={onCancel} aria-label="Close">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="segpick__body">
          <div className="segpick__viewer">
            <div className="segpick__stage">
              {file ? (
                url && (
                  <video
                    ref={videoRef}
                    className="segpick__video"
                    src={url}
                    muted
                    loop
                    playsInline
                    preload="auto"
                    autoPlay={autoPlay}
                    onLoadedMetadata={(e) => {
                      e.currentTarget.currentTime = part.start;
                    }}
                    onTimeUpdate={onTimeUpdate}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    aria-label={`Preview of part ${sel + 1}, ${span}`}
                  />
                )
              ) : meta?.thumbnail ? (
                <img className="segpick__video" src={meta.thumbnail} alt={`Poster of ${meta.title ?? "the video"}`} />
              ) : (
                <span className="segpick__ph" />
              )}
              <span className="segpick__badge">
                Part {sel + 1} · {span}
              </span>
              {file && (
                <button
                  type="button"
                  className="segpick__play"
                  onClick={togglePlay}
                  aria-label={playing ? "Pause preview" : "Play preview"}
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                    {playing ? (
                      <path d="M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z" fill="currentColor" />
                    ) : (
                      <path d="M5 3l8 5-8 5z" fill="currentColor" />
                    )}
                  </svg>
                </button>
              )}
            </div>

            <div className="segpick__timeline" onClick={onTimelineClick} aria-hidden="true">
              {parts.map((p, i) => (
                <span
                  key={p.start}
                  className={`segpick__tick${i === sel ? " is-on" : ""}`}
                  style={{ left: pct(p.start), width: `calc(${pct(p.end)} - ${pct(p.start)})` }}
                />
              ))}
              {file && <span className="segpick__playhead" style={{ left: pct(now) }} />}
            </div>
            <div className="segpick__scale" aria-hidden="true">
              <span>0:00</span>
              <span>{formatClock(duration)}</span>
            </div>

            <div className="segpick__about">
              <p id="segpick-desc" className="segpick__desc">
                ECNet analyzes one minute per run. This {file ? "clip" : "video"} splits into {parts.length} parts;
                pick the one you want checked.
              </p>
              {file && USE_REAL_BACKEND && (
                <p className="segpick__desc">
                  The whole file is uploaded and the server reads only the chosen minute from it.
                </p>
              )}
              {file ? (
                <p className="segpick__file" title={file.name}>
                  {file.name} · {formatBytes(file.size)}
                </p>
              ) : (
                <p className="segpick__file" title={meta?.title ?? (source.kind === "link" ? source.url : "")}>
                  {meta?.title ?? (source.kind === "link" ? source.url : "")}
                  {meta?.uploader ? ` · ${meta.uploader}` : ""}
                  {meta?.extractor ? ` · ${meta.extractor}` : ""}
                </p>
              )}
            </div>
          </div>

          <div className="segpick__parts" role="radiogroup" aria-label="One-minute parts" onKeyDown={onPartsKey}>
            {parts.map((p, i) => (
              <button
                key={p.start}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={i === sel}
                aria-label={`Part ${i + 1}, ${formatSpan(p)}`}
                tabIndex={i === sel ? 0 : -1}
                className={`segpick__part${i === sel ? " is-selected" : ""}`}
                onClick={() => select(i)}
                onDoubleClick={() => onConfirm(p)}
              >
                <span className="segpick__thumb">
                  {thumbs[i] ? (
                    <img src={thumbs[i] as string} alt="" />
                  ) : file ? (
                    <span className={`segpick__ph${done ? "" : " is-loading"}`} />
                  ) : (
                    <span className="segpick__tile">{formatClock(p.start)}</span>
                  )}
                  <span className="segpick__len">{Math.round(p.end - p.start)} s</span>
                </span>
                <span className="segpick__meta">
                  <span className="segpick__name">Part {i + 1}</span>
                  <span className="segpick__range">{formatSpan(p)}</span>
                </span>
                <span className="segpick__radio" aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="12" height="12" fill="none">
                    <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              </button>
            ))}
          </div>
        </div>

        <footer className="segpick__foot">
          <p className="segpick__note">
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
              <path d="M8 7.2v4M8 4.8v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span>Only {span} is analyzed.</span>
          </p>
          <div className="segpick__actions">
            <button type="button" className="tool__ghost" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="tool__cta" onClick={() => onConfirm(part)}>
              Analyze {span}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
