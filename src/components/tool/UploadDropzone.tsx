import { useCallback, useRef, useState, type DragEvent } from "react";
import {
  ACCEPTED_EXTENSIONS,
  MIN_VIDEO_SECONDS,
  probeVideoDuration,
  sniffVideoFile,
  tooShortMessage,
  validateVideoFile,
} from "../../utils/validateVideoFile";
import { needsSegment } from "../../utils/segments";
import "./UploadDropzone.css";

interface UploadDropzoneProps {
  onFileAccepted: (file: File) => void;
  /** A clip over a minute: the caller asks which minute to analyze. */
  onLongFile: (file: File, duration: number) => void;
}

export function UploadDropzone({ onFileAccepted, onLongFile }: UploadDropzoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      const file = files?.[0];
      if (!file) return;

      const result = validateVideoFile(file);
      if (!result.valid) {
        setError(result.error ?? "This file can't be used.");
        return;
      }

      setError(null);
      setChecking(true);
      const notVideo = await sniffVideoFile(file);
      // null: the browser cannot read it (mkv/avi often); the server decides
      const duration = notVideo ? null : await probeVideoDuration(file);
      setChecking(false);
      if (inputRef.current) inputRef.current.value = "";   // same file again re-fires change
      if (notVideo) setError(notVideo);
      else if (duration !== null && duration <= MIN_VIDEO_SECONDS) setError(tooShortMessage(duration));
      else if (needsSegment(duration)) onLongFile(file, duration);
      else onFileAccepted(file);
    },
    [onFileAccepted, onLongFile],
  );

  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  };

  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setIsDragging(false);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  };

  return (
    <div className="dropzone-wrap">
      <div
        className={`dropzone${isDragging ? " is-dragging" : ""}${error ? " has-error" : ""}`}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        aria-label="Upload video for analysis"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={[...ACCEPTED_EXTENSIONS, "video/*"].join(",")}
          className="dropzone__input"
          onChange={(e) => handleFiles(e.target.files)}
          tabIndex={-1}
        />

        <span className="dropzone__badge" aria-hidden="true">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 16V4M12 4L7 9M12 4l5 5"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>

        <p className="dropzone__title">
          {checking
            ? "Checking video…"
            : isDragging
              ? "Drop to analyze"
              : "Drag & drop a video"}
        </p>
        {!isDragging && !checking && (
          <p className="dropzone__sub">
            or <span className="dropzone__browse">browse files</span>
          </p>
        )}
        <p className="dropzone__hint">
          <span className="dropzone__chip">
            {ACCEPTED_EXTENSIONS.map((ext) => ext.slice(1)).join(" · ")}
          </span>
          <span className="dropzone__chip">over {MIN_VIDEO_SECONDS} s · 1 min per analysis</span>
        </p>
      </div>

      {error && (
        <p className="dropzone__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
