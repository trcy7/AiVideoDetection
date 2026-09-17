import type { AnalysisResult, Verdict } from "../../types";
import "./VerdictCard.css";

interface VerdictCardProps {
  result: AnalysisResult;
}

const VERDICT_COPY: Record<Verdict, { label: string; description: string }> = {
  real: { label: "Real", description: "No AI traces found." },
  fake: { label: "AI Generated", description: "AI-generation artifacts detected." },
  uncertain: { label: "Uncertain", description: "Mixed signal — review manually." },
};

/** Color a branch bar with the SAME calibrated bands the verdict uses, so a
 *  score of 80 reads "uncertain" (not "fake") when the checkpoint's fake
 *  threshold is 94. Falls back to 35/65 for mock/older results without bands. */
function VerdictIcon({ verdict }: { verdict: Verdict }) {
  if (verdict === "real") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (verdict === "fake") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3v6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="8" cy="12.5" r="1.3" fill="currentColor" />
    </svg>
  );
}

export function VerdictCard({ result }: VerdictCardProps) {
  const copy = VERDICT_COPY[result.verdict];

  // The hybrid's branches. Spatial = EfficientNet (per-frame texture artifacts).
  // Temporal = ConvLSTM over contiguous frames (motion artifacts); it rides in
  // the opticalFlow slot of the backend contract. Frequency = FFT spectral
  // artifacts (generator fingerprints) -- only present for frequency-branch
  // checkpoints, so it's shown only when non-null. Temporal is null on history
  // items from older spatial-only checkpoints, so both shapes must render.
  const branches: Array<{ label: string; value: number | null }> = [
    { label: "Spatial (EfficientNet)", value: result.branchScores.spatial },
    { label: "Temporal (ConvLSTM)", value: result.branchScores.opticalFlow },
  ];
  if (result.branchScores.frequency != null) {
    branches.push({ label: "Frequency (FFT)", value: result.branchScores.frequency });
  }
  // Motion is intentionally hidden from the results UI (kept in the model/report).

  return (
    <div className="verdict-card">
      <div className="verdict-card__top">
        <span className={`verdict-card__badge verdict-card__badge--${result.verdict}`}>
          <VerdictIcon verdict={result.verdict} />
          {copy.label}
        </span>
        <span className="verdict-card__confidence">
          {result.confidence.toFixed(1)}%
          <span className="verdict-card__confidence-label"> confidence</span>
        </span>
      </div>

      <p className="verdict-card__description">{copy.description}</p>

      <div className="verdict-card__branches">
        <span className="verdict-card__branches-title">Branch scores</span>
        {branches.map((branch) => {
          if (branch.value === null) {
            return (
              <div key={branch.label} className="verdict-card__branch is-pending">
                <span className="verdict-card__branch-label">{branch.label}</span>
                <div className="verdict-card__branch-track" aria-hidden="true" />
                <span
                  className="verdict-card__branch-soon"
                  title="Not available for this analysis (older model result)"
                >
                  n/a
                </span>
              </div>
            );
          }
          // Bars take the VERDICT's colour, not each branch's own zone: a "real"
          // call reads green throughout, so the evidence never looks like it
          // contradicts the headline.
          const zone = result.verdict;
          return (
            <div key={branch.label} className="verdict-card__branch">
              <span className="verdict-card__branch-label">{branch.label}</span>
              <div
                className="verdict-card__branch-track"
                role="img"
                aria-label={`${branch.label} branch: ${Math.round(branch.value)} out of 100`}
              >
                <div
                  className={`verdict-card__branch-fill verdict-card__branch-fill--${zone}`}
                  style={{ width: `${branch.value}%` }}
                />
              </div>
              <span className="verdict-card__branch-value">
                {Math.round(branch.value)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
