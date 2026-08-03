import { useEffect, useState } from "react";
import type { Verdict } from "../../types";
import "./ConfidenceGauge.css";

interface ConfidenceGaugeProps {
  /** 0 = certainly real … 100 = certainly fake. */
  score: number;
  verdict: Verdict;
  /** Calibrated thresholds from the model checkpoint. When absent the gauge
   *  falls back to the historical 35/65 split (mock results). */
  bands?: { realBelow: number; fakeAbove: number };
}

const CX = 110;
const CY = 110;
const R = 86;

/** Point on the arc for a score percentage (0 = far left, 100 = far right). */
function polar(pct: number, radius = R): [number, number] {
  const theta = Math.PI * (1 - pct / 100);
  return [CX + radius * Math.cos(theta), CY - radius * Math.sin(theta)];
}

function arcPath(fromPct: number, toPct: number): string {
  const [x1, y1] = polar(fromPct);
  const [x2, y2] = polar(toPct);
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

// The dial is drawn in EQUAL THIRDS and the score is mapped onto it, rather
// than plotting the raw 0-100 score linearly.
//
// Why: calibrated bands are wildly asymmetric. hybridmodel7 uses real<62 / fake>94,
// so a linear dial gives most of the arc to "real" and a thin sliver to "fake" --
// a score of 88 then LOOKS deep in the red while correctly reading
// "uncertain". Mapping each band to a third keeps the needle's position
// meaningful for any calibration: left third = real, middle = uncertain,
// right third = AI. The numeric readout still shows the true raw score.
const GAP = 1.1;
const T1 = 100 / 3;        // real | uncertain boundary on the dial
const T2 = 200 / 3;        // uncertain | AI boundary on the dial

const ZONES = [
  { from: 0, to: T1 - GAP, cls: "gauge__zone--real" },
  { from: T1 + GAP, to: T2 - GAP, cls: "gauge__zone--uncertain" },
  { from: T2 + GAP, to: 100, cls: "gauge__zone--fake" },
];

/** Piecewise-linear map: raw score -> dial position, so the calibrated
 *  thresholds always land exactly on the zone boundaries. */
function scoreToDial(score: number, realBelow: number, fakeAbove: number): number {
  const s = Math.max(0, Math.min(100, score));
  if (s <= realBelow) {
    return realBelow <= 0 ? 0 : (s / realBelow) * T1;
  }
  if (s <= fakeAbove) {
    const span = fakeAbove - realBelow;
    return span <= 0 ? T1 : T1 + ((s - realBelow) / span) * (T2 - T1);
  }
  const span = 100 - fakeAbove;
  return span <= 0 ? 100 : T2 + ((s - fakeAbove) / span) * (100 - T2);
}

const VERDICT_LABEL: Record<Verdict, string> = {
  real: "Real",
  fake: "AI Generated",
  uncertain: "Uncertain",
};

export function ConfidenceGauge({ score, verdict, bands }: ConfidenceGaugeProps) {
  // Start at 0 and move to the score after mount so the CSS transition sweeps
  const [displayScore, setDisplayScore] = useState(0);

  useEffect(() => {
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => setDisplayScore(score)),
    );
    return () => cancelAnimationFrame(raf);
  }, [score]);

  const realBelow = bands?.realBelow ?? 35;
  const fakeAbove = bands?.fakeAbove ?? 65;
  const zones = ZONES;
  // needle follows the MAPPED position so it always sits in the zone that
  // matches the verdict, whatever the checkpoint's calibration happens to be
  const needleDeg = (scoreToDial(displayScore, realBelow, fakeAbove) / 100) * 180;

  return (
    <div
      className={`gauge gauge--${verdict}`}
      role="img"
      aria-label={`Verdict: ${VERDICT_LABEL[verdict]}`}
    >
      <svg viewBox="0 0 220 132" className="gauge__svg" aria-hidden="true">
        {zones.map((zone) => (
          <path
            key={zone.cls}
            className={`gauge__zone ${zone.cls}`}
            d={arcPath(zone.from, zone.to)}
            fill="none"
            strokeWidth="14"
          />
        ))}

        <text x={CX - R} y={CY + 18} className="gauge__axis-label" textAnchor="middle">
          Real
        </text>
        <text x={CX} y={CY - R - 10} className="gauge__axis-label" textAnchor="middle">
          Uncertain
        </text>
        <text x={CX + R} y={CY + 18} className="gauge__axis-label" textAnchor="middle">
          AI Gen
        </text>

        <g
          className="gauge__needle-group"
          style={{ transform: `rotate(${needleDeg}deg)` }}
        >
          <polygon
            className="gauge__needle"
            points={`${CX - R + 14},${CY} ${CX + 6},${CY - 5} ${CX + 6},${CY + 5}`}
          />
        </g>
        <circle className="gauge__pivot" cx={CX} cy={CY} r="7" />
      </svg>
    </div>
  );
}
