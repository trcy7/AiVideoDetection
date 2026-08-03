import type { Verdict, VideoMetadata } from "../../types";
import { formatBytes } from "../../utils/validateVideoFile";
import { formatDuration } from "../../utils/videoMetadata";
import "./VideoPreview.css";

interface VideoPreviewProps {
  fileName: string;
  fileSize: number;
  metadata: VideoMetadata;
  verdict: Verdict;
  frameCount: number;
  /** Live analyses have the object URL; history restores only a thumbnail. */
  videoUrl: string | null;
  thumbnail: string | null;
}

const VERDICT_BADGE: Record<Verdict, string> = {
  real: "Real",
  fake: "AI Generated",
  uncertain: "Uncertain",
};

const DASH = "—";

export function VideoPreview({
  fileName,
  fileSize,
  metadata,
  verdict,
  frameCount,
  videoUrl,
  thumbnail,
}: VideoPreviewProps) {
  const meta = [
    {
      label: "Resolution",
      value: metadata.width && metadata.height ? `${metadata.width} × ${metadata.height}` : DASH,
    },
    {
      label: "Duration",
      value: metadata.duration !== null ? formatDuration(metadata.duration) : DASH,
    },
    { label: "Frames", value: `${frameCount} analyzed` },
    { label: "Size", value: fileSize > 0 ? formatBytes(fileSize) : DASH },
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
