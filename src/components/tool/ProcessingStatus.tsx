import "./ProcessingStatus.css";

/* ---- Preprocessing: small sequential substeps ---- */

// v1 preprocessing: full frames, letterboxed — no face detection/alignment
export const PREPROCESS_STEPS = [
  "Extracting frames",
  "Letterboxing & normalizing",
];

interface PreprocessingStatusProps {
  /** Index of the substep currently running; steps before it are done. */
  activeStep: number;
}

export function PreprocessingStatus({ activeStep }: PreprocessingStatusProps) {
  return (
    <div className="processing-card" role="status" aria-live="polite">
      <span className="processing-card__title">Preprocessing</span>
      <ul className="preprocess-steps">
        {PREPROCESS_STEPS.map((label, i) => {
          const state = i < activeStep ? "done" : i === activeStep ? "active" : "pending";
          return (
            <li key={label} className={`preprocess-steps__item is-${state}`}>
              <span className="preprocess-steps__marker" aria-hidden="true">
                {state === "done" ? (
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M3 8.5l3 3 7-7"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : state === "active" ? (
                  <span className="preprocess-steps__spinner" />
                ) : null}
              </span>
              {label}
              {state === "done" && <span className="visually-hidden"> (done)</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ---- Analyzing: progress bar + stepped stage labels ---- */

// v1 runs the spatial branch only — stages must not claim analyses that
// don't exist yet (frequency/optical flow arrive in v2).
export const ANALYSIS_STAGES: Array<{ from: number; label: string }> = [
  { from: 0, label: "Sampling frames" },
  { from: 22, label: "Spatial artifact analysis — EfficientNet" },
  { from: 55, label: "Scoring frames" },
  { from: 78, label: "Aggregating video verdict" },
  { from: 92, label: "Compiling report" },
];

interface AnalyzingStatusProps {
  /** 0–100 */
  progress: number;
}

export function AnalyzingStatus({ progress }: AnalyzingStatusProps) {
  const stage = [...ANALYSIS_STAGES].reverse().find((s) => progress >= s.from);

  return (
    <div className="processing-card" role="status" aria-live="polite">
      <div className="analyzing__header">
        <span className="processing-card__title">Analyzing</span>
        <span className="analyzing__percent">{Math.round(progress)}%</span>
      </div>
      <div
        className="analyzing__bar"
        role="progressbar"
        aria-valuenow={Math.round(progress)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Analysis progress"
      >
        <div className="analyzing__bar-fill" style={{ width: `${progress}%` }} />
      </div>
      <span className="analyzing__stage">{stage?.label}</span>
    </div>
  );
}
