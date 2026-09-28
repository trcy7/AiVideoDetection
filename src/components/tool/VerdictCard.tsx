import type { AnalysisResult, Verdict } from "../../types";
import { DEFAULT_BANDS } from "../../utils/bands";
import { branchList } from "./branches";
import { ConfidenceGauge } from "./ConfidenceGauge";
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

        <ConfidenceGauge
          score={result.fakeScore}
          verdict={result.verdict}
          bands={result.bands}
        />

        {/* the dial already names the three zones; this carries the numbers */}
        <p className="vc__bands">
          Real <b>&le; {lo}</b> · AI generated <b>&ge; {hi}</b>
        </p>
      </div>
    </section>
  );
}
