import type { AnalysisResult } from "../../types";
import { branchList } from "./branches";
import "./DetectorCard.css";

interface DetectorCardProps {
  result: AnalysisResult;
}

/** What each branch of the model scored the clip, on its own. */
export function DetectorCard({ result }: DetectorCardProps) {
  const rows = branchList(result.branchScores);

  return (
    <section className="dcard glass-card" aria-labelledby="dcard-title">
      <div className="dcard__intro">
        <h2 id="dcard-title" className="dcard__heading">Branch scores</h2>
        <p className="dcard__sub">Independent score per branch, 0–100.</p>
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
                  : `${row.name} branch: ${Math.round(row.value)} out of 100`
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
            </div>

            <p className="dcard__desc">{row.description}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
