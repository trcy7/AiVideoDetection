import type { AnalysisResult, Verdict } from "../../types";
import { DEFAULT_BANDS } from "../../utils/bands";
import { branchList } from "./branches";
import "./VerdictCard.css";

interface VerdictCardProps {
  result: AnalysisResult;
}

const LABEL: Record<Verdict, string> = {
  real: "Real",
  fake: "AI Generated",
  uncertain: "Uncertain",
};

const GLYPH: Record<Verdict, string> = {
  real: "M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6l8-3zM8.5 12l2.5 2.5 4.5-5",
  fake: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01",
  uncertain: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4M12 17h.01",
};

const clamp = (n: number) => Math.min(100, Math.max(0, n));

/** One sentence that says what the score means, in terms of the bands that
 *  produced it -- the number alone tells the reader nothing. */
function summary(verdict: Verdict, above: number, total: number, lo: number, hi: number): string {
  if (verdict === "fake") {
    const who =
      above === 0
        ? "The combined score is"
        : above === total
          ? `All ${total} branches scored this clip`
          : `${above} of ${total} branches scored this clip`;
    return `${who} at or above ${hi}. Review the flagged frames before acting on this result.`;
  }
  if (verdict === "uncertain") {
    return `The score falls between ${lo} and ${hi}, so no verdict is issued. Review the flagged frames.`;
  }
  return `The score is at or below ${lo}. No sustained generation artifacts were found across the clip.`;
}

export function VerdictCard({ result }: VerdictCardProps) {
  const lo = result.bands?.realBelow ?? DEFAULT_BANDS.realBelow;
  const hi = result.bands?.fakeAbove ?? DEFAULT_BANDS.fakeAbove;
  const branches = branchList(result.branchScores);
  const above = branches.filter((b) => b.value !== null && b.value >= hi).length;

  // The uncertain band is only as wide as the calibration makes it -- 5 points
  // here. Its label cannot fit that column, and forcing it wraps "Uncertain"
  // down three lines, so below 15 points the zone goes unlabelled: the two
  // ticks bracket it and the verdict text names it.
  const roomForMiddle = hi - lo >= 15;
  const zones: Array<{ key: Verdict; label: string; short: string; width: number }> = [
    { key: "real", label: "Real", short: "Real", width: lo },
    {
      key: "uncertain",
      label: roomForMiddle ? "Uncertain" : "",
      short: roomForMiddle ? "Unsure" : "",
      width: Math.max(0, hi - lo),
    },
    { key: "fake", label: "AI Generated", short: "AI", width: Math.max(0, 100 - hi) },
  ];

  return (
    <section className={`vc vc--${result.verdict}`} aria-labelledby="vc-title">
      <div className="vc__main">
        <div className="vc__head">
          <span className="vc__icon" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d={GLYPH[result.verdict]} />
            </svg>
          </span>
          <div>
            <span className="hud-label">Verdict</span>
            <h2 id="vc-title" className="vc__name">{LABEL[result.verdict]}</h2>
          </div>
        </div>

        <p className="vc__text">{summary(result.verdict, above, branches.length, lo, hi)}</p>

        <p className="vc__chip">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12l5 5 9-10" />
          </svg>
          {above} of {branches.length} branches at or above {hi}
        </p>
      </div>

      <div className="vc__panel">
        <dl className="vc__stats">
          <div>
            <dt>AI likelihood score</dt>
            <dd>
              <span className="vc__stat-value">{result.fakeScore.toFixed(1)}</span>
              <span className="vc__stat-unit">/ 100</span>
            </dd>
          </div>
          <div>
            <dt>Model confidence</dt>
            <dd>
              <span className="vc__stat-value">{result.confidence.toFixed(1)}%</span>
            </dd>
          </div>
        </dl>

        <div className="vc__scale">
          <div className="vc__scale-labels" aria-hidden="true">
            {zones.map((z) => (
              <span
                key={z.key}
                style={{ width: `${z.width}%` }}
                className={z.key === result.verdict ? "is-active" : undefined}
              >
                <span className="vc__long">{z.label}</span>
                <span className="vc__short">{z.short}</span>
              </span>
            ))}
          </div>

          <div
            className="vc__track"
            role="img"
            aria-label={`Score ${result.fakeScore.toFixed(1)} of 100. Real at or below ${lo}, AI generated at or above ${hi}.`}
          >
            <div className="vc__zones">
              {zones.map((z) => (
                <span key={z.key} className={`vc__zone vc__zone--${z.key}`} style={{ width: `${z.width}%` }} />
              ))}
            </div>
            <span className="vc__marker" style={{ left: `${clamp(result.fakeScore)}%` }} />
          </div>

          {/* Only the two thresholds are labelled. 0 and 100 are the ends of a
              0-100 bar and add nothing, and with the bands 5 points apart they
              would crowd the numbers that matter. */}
          <div className="vc__ticks" aria-hidden="true">
            <span style={{ left: `${lo}%` }}>{lo}</span>
            <span style={{ left: `${hi}%` }}>{hi}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
