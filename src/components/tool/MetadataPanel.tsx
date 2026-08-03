import { useEffect, useRef, useState } from "react";
import type { VideoMetadata } from "../../types";
import { formatBytes } from "../../utils/validateVideoFile";
import { estimateFrameRate, formatDuration } from "../../utils/videoMetadata";
import "./MetadataPanel.css";

interface MetadataPanelProps {
  fileName: string;
  fileSize: number;
  metadata: VideoMetadata;
  /** Object URL of the uploaded file, shown as a small preview thumbnail. */
  videoUrl: string | null;
  /** Reports the frame rate once it has been measured on the thumbnail. */
  onFrameRate: (fps: number) => void;
}

const DASH = "—";

export function MetadataPanel({
  fileName,
  fileSize,
  metadata,
  videoUrl,
  onFrameRate,
}: MetadataPanelProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [previewBroken, setPreviewBroken] = useState(false);

  // The thumbnail doubles as the frame-rate probe: fps is measured by
  // counting decoded frames, and browsers only decode at full rate for
  // videos that are actually visible.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoUrl || previewBroken) return;
    return estimateFrameRate(video, onFrameRate);
  }, [videoUrl, previewBroken, onFrameRate]);

  const fields = [
    {
      label: "Duration",
      value: metadata.duration !== null ? formatDuration(metadata.duration) : DASH,
    },
    {
      label: "Resolution",
      value:
        metadata.width && metadata.height
          ? `${metadata.width} × ${metadata.height}`
          : DASH,
    },
    {
      label: "Frame Rate",
      value: metadata.frameRate !== null ? `${metadata.frameRate} fps` : DASH,
    },
    { label: "Codec", value: metadata.codec ?? DASH },
  ];

  return (
    <div className="metadata-panel">
      <div className="metadata-panel__file">
        {videoUrl && !previewBroken && (
          <video
            ref={videoRef}
            className="metadata-panel__thumb"
            src={videoUrl}
            muted
            playsInline
            preload="auto"
            onError={() => setPreviewBroken(true)}
            aria-label={`Preview of ${fileName}`}
          />
        )}
        <div className="metadata-panel__file-text">
          <span className="metadata-panel__file-name" title={fileName}>
            {fileName}
          </span>
          <span className="metadata-panel__file-size">{formatBytes(fileSize)}</span>
        </div>
      </div>
      <dl className="metadata-panel__grid">
        {fields.map((field) => (
          <div key={field.label} className="metadata-panel__cell">
            <dt>{field.label}</dt>
            <dd>{field.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
