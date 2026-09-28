import type { AnalysisResult } from "../../types";
import { cleanModelVersion } from "../../utils/realBackend";
import { formatScanTime } from "../../utils/videoMetadata";
import "./ResultHeader.css";

interface ResultHeaderProps {
  result: AnalysisResult;
  onAnalyzeAnother: () => void;
}

function Icon({ d, size = 17 }: { d: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}

const EYE = "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z";
const DOWNLOAD = "M12 4v11M7 10l5 5 5-5M5 20h14";
const PLUS = "M12 5v14M5 12h14";

/** Report head: what was analysed, when, and the three things you can do next.
 *  The actions used to sit in a card of their own halfway down the page. */
export function ResultHeader({ result, onAnalyzeAnother }: ResultHeaderProps) {
  const completed = new Date(result.analyzedAt);
  const stem = result.fileName.replace(/\.[^/.]+$/, "");

  return (
    <header className="rhead">
      <div className="rhead__text">
        <p className="hud-label rhead__eyebrow">Analysis report</p>
        <h1 className="rhead__title" title={result.fileName}>
          {result.fileName}
        </h1>
        <ul className="rhead__meta">
          <li>
            {completed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
            {", "}
            {completed.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
          </li>
          <li>
            Scan time <strong>{formatScanTime(result.processingMs)}</strong>
          </li>
          <li>
            Model <strong className="rhead__mono">{cleanModelVersion(result.modelVersion)}</strong>
          </li>
        </ul>
      </div>

      <div className="rhead__actions">
        <a
          className="rbtn"
          href={result.reportUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Icon d={EYE} /> View report
        </a>
        <a className="rbtn" href={result.reportUrl} download={`${stem}-ecnet-report.pdf`}>
          <Icon d={DOWNLOAD} /> Download PDF
        </a>
        <button type="button" className="rbtn rbtn--primary" onClick={onAnalyzeAnother}>
          <Icon d={PLUS} /> Analyze another video
        </button>
      </div>
    </header>
  );
}
