import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HistoryItem, Verdict } from "../../types";
import { getVideo } from "../../utils/videoStore";
import { formatScanTime } from "../../utils/videoMetadata";
import { formatSpan, isPartial, keepInside } from "../../utils/segments";
import "./HistoryPanel.css";

const VERDICT_SHORT: Record<Verdict, string> = {
  real: "Real",
  fake: "AI Gen",
  uncertain: "Uncertain",
};

function shortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " · " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

interface HistoryCardProps {
  item: HistoryItem;
  selected: boolean;
  onSelect: (item: HistoryItem) => void;
  onRemove: (id: string) => void;
}

export function HistoryCard({ item, selected, onSelect, onRemove }: HistoryCardProps) {
  const { result } = item;
  // the stored clip of a link is its preview, which already starts at the part
  const seg = isPartial(result.segment) ? result.segment : null;
  const shift = result.clipStart ?? 0;
  const part = useMemo(
    () => (seg ? { start: Math.max(0, seg.start - shift), end: seg.end - shift } : null),
    [seg, shift],
  );
  const videoRef = useRef<HTMLVideoElement>(null);
  const urlRef = useRef<string | null>(null);
  const pending = useRef(false);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [hot, setHot] = useState(false);

  // Blobs load on first hover, not on mount: twenty rows each pulling a clip
  // out of IndexedDB to sit paused is work nobody asked for. Until then the
  // poster carries the row.
  const wake = useCallback(() => {
    setHot(true);
    if (urlRef.current || pending.current) return;
    pending.current = true;
    getVideo(item.id)
      .then((blob) => {
        if (!blob || urlRef.current) return;
        urlRef.current = URL.createObjectURL(blob);
        setClipUrl(urlRef.current);
      })
      .finally(() => {
        pending.current = false;
      });
  }, [item.id]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !clipUrl) return;
    if (hot) {
      if (part && (v.currentTime < part.start || v.currentTime >= part.end)) v.currentTime = part.start;
      void v.play().catch(() => {});
    } else {
      v.pause();
      v.currentTime = part?.start ?? 0;
    }
  }, [hot, clipUrl, part]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  return (
    <div className={`hcard hcard--${result.verdict}${selected ? " is-selected" : ""}`}>
      <button
        type="button"
        className="hcard__body"
        onClick={() => onSelect(item)}
        onMouseEnter={wake}
        onMouseLeave={() => setHot(false)}
        onFocus={wake}
        onBlur={() => setHot(false)}
        aria-pressed={selected}
        aria-label={`Open analysis of ${result.fileName}: ${VERDICT_SHORT[result.verdict]}, ${Math.round(result.confidence)} percent confidence`}
      >
        <span className="hcard__thumb" aria-hidden="true">
          {clipUrl ? (
            <video
              ref={videoRef}
              src={clipUrl}
              poster={item.thumbnail ?? undefined}
              muted
              loop
              playsInline
              preload="metadata"
              onTimeUpdate={(e) => keepInside(e.currentTarget, part)}
            />
          ) : item.thumbnail ? (
            <img src={item.thumbnail} alt="" loading="lazy" />
          ) : (
            <svg viewBox="0 0 24 24" fill="none">
              <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10 9.5l5 2.5-5 2.5v-5z" fill="currentColor" />
            </svg>
          )}
        </span>

        <span className="hcard__text">
          <span className="hcard__name" title={result.fileName}>
            {result.fileName}
          </span>
          <span className="hcard__row">
            <span className={`hcard__verdict hcard__verdict--${result.verdict}`}>
              {VERDICT_SHORT[result.verdict]}
            </span>
            <span className="hcard__confidence">{Math.round(result.confidence)}%</span>
            {seg && (
              <span className="hcard__part" title="Part analyzed">
                {formatSpan(seg)}
              </span>
            )}
          </span>
          <span className="hcard__row hcard__row--meta">
            <span>{shortDate(item.savedAt)}</span>
            <span>{formatScanTime(result.processingMs)}</span>
          </span>
        </span>
      </button>

      <button
        type="button"
        className="hcard__delete"
        onClick={() => onRemove(item.id)}
        aria-label={`Delete history entry for ${result.fileName}`}
        title="Delete"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
