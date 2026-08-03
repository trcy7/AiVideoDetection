import type { AnalysisResult } from "../../types";
import { cleanModelVersion } from "../../utils/realBackend";
import "./ResultHeader.css";

interface ResultHeaderProps {
  result: AnalysisResult;
}

export function ResultHeader({ result }: ResultHeaderProps) {
  const meta = [
    { label: "Scan time", value: `${(result.processingMs / 1000).toFixed(1)}s` },
    { label: "Frames", value: String(result.frames.length) },
    { label: "Model", value: cleanModelVersion(result.modelVersion) },
    { label: "Completed", value: new Date(result.analyzedAt).toLocaleString() },
  ];

  return (
    <header className="rheader glass-card">
      <div className="rheader__text">
        <h2 className="rheader__title">
          <span className="rheader__pulse" aria-hidden="true" />
          Analysis complete
        </h2>
        <dl className="rheader__meta">
          {meta.map((entry) => (
            <div key={entry.label} className="rheader__meta-item">
              <dt className="hud-label">{entry.label}</dt>
              <dd>{entry.value}</dd>
            </div>
          ))}
        </dl>
      </div>

    </header>
  );
}
