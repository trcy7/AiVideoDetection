import { useCallback, useRef, useState, type DragEvent } from "react";
import {
  ACCEPTED_EXTENSIONS,
  checkVideoDuration,
  validateVideoFile,
} from "../../utils/validateVideoFile";
import "./UploadDropzone.css";

interface UploadDropzoneProps {
  onFileAccepted: (file: File) => void;
}

export function UploadDropzone({ onFileAccepted }: UploadDropzoneProps) {
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
      const duration = await checkVideoDuration(file);
      setChecking(false);
      if (!duration.valid) {
        setError(duration.error ?? "This video is too long.");
        return;
      }

      onFileAccepted(file);
    },
    [onFileAccepted],
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
          {ACCEPTED_EXTENSIONS.join(" · ")} · up to 1 minute
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
