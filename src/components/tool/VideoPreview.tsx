import type { Verdict, VideoMetadata, VideoSegment } from "../../types";
import { formatDuration } from "../../utils/videoMetadata";
import { formatSpan, isPartial } from "../../utils/segments";
import "./VideoPreview.css";

interface VideoPreviewProps {
  fileName: string;
  metadata: VideoMetadata;
  verdict: Verdict;
  /** Live analyses have the object URL; history restores only a thumbnail. */
  videoUrl: string | null;
  thumbnail: string | null;
  /** The analyzed part of a long clip; the player opens on it. */
  segment?: VideoSegment | null;
  /** Source time at second 0 of videoUrl. */
  videoOffset?: number;
}

const VERDICT_BADGE: Record<Verdict, string> = {
  real: "Real",
  fake: "AI Generated",
  uncertain: "Uncertain",
};

const DASH = "—";

export function VideoPreview({
  fileName,
  metadata,
  verdict,
  videoUrl,
  thumbnail,
  segment,
  videoOffset = 0,
}: VideoPreviewProps) {
  const part = isPartial(segment) ? segment : null;
  const meta = [
    {
      label: "Resolution",
      value: metadata.width && metadata.height ? `${metadata.width} × ${metadata.height}` : DASH,
    },
    {
      label: "Duration",
      value: metadata.duration !== null ? formatDuration(metadata.duration) : DASH,
    },
    ...(part ? [{ label: "Analyzed", value: formatSpan(part) }] : []),
  ];

  return (
    <section className="vpreview glass-card" aria-label="Analyzed video">
      <div className="vpreview__stage">
        {videoUrl ? (
          <video
            className="vpreview__media"
            src={videoUrl}
            controls
            muted
            playsInline
            preload="metadata"
            aria-label={`Preview of ${fileName}`}
            onLoadedMetadata={(e) => {
              if (part) e.currentTarget.currentTime = Math.max(0, part.start - videoOffset);
            }}
          />
        ) : thumbnail ? (
          <img className="vpreview__media" src={thumbnail} alt={`Thumbnail of ${fileName}`} />
        ) : (
          <div className="vpreview__missing">
            <span className="hud-label">No preview</span>
            <p>Source video unavailable.</p>
          </div>
        )}

        <span className={`vpreview__verdict vpreview__verdict--${verdict}`}>
          {VERDICT_BADGE[verdict]}
        </span>

        {/* decorative scan overlay */}
        <div className="vpreview__scan" aria-hidden="true">
          <span className="vpreview__scanline" />
          <span className="vpreview__corner vpreview__corner--tl" />
          <span className="vpreview__corner vpreview__corner--tr" />
          <span className="vpreview__corner vpreview__corner--bl" />
          <span className="vpreview__corner vpreview__corner--br" />
        </div>
      </div>

      <div className="vpreview__info">
        <span className="vpreview__filename" title={fileName}>
          {fileName}
        </span>
        <dl className="vpreview__meta">
          {meta.map((entry) => (
            <div key={entry.label} className="vpreview__meta-cell">
              <dt className="hud-label">{entry.label}</dt>
              <dd>{entry.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
