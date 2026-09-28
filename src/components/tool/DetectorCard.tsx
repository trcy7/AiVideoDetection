import type { AnalysisResult } from "../../types";
import { DEFAULT_BANDS } from "../../utils/bands";
import { branchList } from "./branches";
import "./DetectorCard.css";

interface DetectorCardProps {
  result: AnalysisResult;
}

/** Per-branch scores with the AI threshold drawn on every bar, so a bar that
 *  clears it is visible rather than something the reader has to work out. */
export function DetectorCard({ result }: DetectorCardProps) {
  const hi = result.bands?.fakeAbove ?? DEFAULT_BANDS.fakeAbove;
  const rows = branchList(result.branchScores);

  return (
    <section className="dcard glass-card" aria-labelledby="dcard-title">
      <div className="dcard__intro">
        <h2 id="dcard-title" className="dcard__heading">Branch breakdown</h2>
        <p className="dcard__sub">Each branch scores the clip on its own, 0 to 100.</p>
      </div>

      <ul className="dcard__list">
        {rows.map((row) => (
          <li key={row.id} className="dcard__item">
            <div className="dcard__item-head">
              <div className="dcard__item-name">
                <span className="dcard__name">{row.name}</span>
                <span className="dcard__model">{row.model}</span>
              </div>
              <span className="dcard__score">
                {row.value === null ? <small>n/a</small> : Math.round(row.value)}
              </span>
            </div>

            <div
              className="dcard__bar"
              role="img"
              aria-label={
                row.value === null
                  ? `${row.name} branch: not available for this analysis`
                  : `${row.name} branch: ${Math.round(row.value)} out of 100, AI threshold ${hi}`
              }
            >
              {row.value !== null && (
                /* Bars take the VERDICT's colour, not each branch's own zone, so a
                   Real call reads green throughout and the evidence never looks
                   like it contradicts the headline. */
                <span
                  className={`dcard__fill dcard__fill--${result.verdict}`}
                  style={{ width: `${Math.min(100, Math.max(0, row.value))}%` }}
                />
              )}
              <span className="dcard__threshold" style={{ left: `${hi}%` }} />
            </div>

            <p className="dcard__desc">{row.description}</p>
          </li>
        ))}
      </ul>

      <p className="dcard__note">
        <span className="dcard__swatch" aria-hidden="true" />
        Marker shows the AI threshold ({hi})
      </p>
    </section>
  );
}
