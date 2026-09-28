import type { WindowScore } from "../../types";
import "./ScoreTimeline.css";

interface ScoreTimelineProps {
  windows: WindowScore[];
  /** Calibrated thresholds, so the bands match the model's own calibration. */
  bands?: { realBelow: number; fakeAbove: number };
  /** The clip's overall score — drawn as the mean line. */
  fakeScore: number;
}

const W = 600;
const H = 150;
const PAD_L = 26;
const PAD_R = 8;
const PAD_T = 8;
const PAD_B = 20;

/** Per-window scores across the clip. The verdict is the MEAN of these, so a
 *  clip that is uniformly uncertain and one that is confident in opposite
 *  directions at different moments produce the same number — this is where
 *  that difference becomes visible. */
export function ScoreTimeline({ windows, bands, fakeScore }: ScoreTimelineProps) {
  if (windows.length < 2) return null;

  const realBelow = bands?.realBelow ?? 35;
  const fakeAbove = bands?.fakeAbove ?? 65;
  const lastTime = windows[windows.length - 1].time || 1;

  const x = (t: number) => PAD_L + (t / lastTime) * (W - PAD_L - PAD_R);
  const y = (s: number) => PAD_T + (1 - s / 100) * (H - PAD_T - PAD_B);

  const line = windows.map((w) => `${x(w.time).toFixed(1)},${y(w.score).toFixed(1)}`).join(" ");
  const area = `${x(windows[0].time).toFixed(1)},${y(0)} ${line} ${x(lastTime).toFixed(1)},${y(0)}`;

  const above = windows.filter((w) => w.score > fakeAbove).length;
  const share = Math.round((above / windows.length) * 100);

  return (
    <figure className="stl">
      <svg
        className="stl__svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Score per window across the clip. ${share}% of ${windows.length} windows scored above the AI threshold of ${fakeAbove}.`}
      >
        {/* verdict bands as ground, so a point's meaning is readable by height */}
        <rect x={PAD_L} y={y(100)} width={W - PAD_L - PAD_R} height={y(fakeAbove) - y(100)} className="stl__zone stl__zone--fake" />
        <rect x={PAD_L} y={y(fakeAbove)} width={W - PAD_L - PAD_R} height={y(realBelow) - y(fakeAbove)} className="stl__zone stl__zone--unc" />
        <rect x={PAD_L} y={y(realBelow)} width={W - PAD_L - PAD_R} height={y(0) - y(realBelow)} className="stl__zone stl__zone--real" />

        {[0, 50, 100].map((v) => (
          <g key={v}>
            <line x1={PAD_L} y1={y(v)} x2={W - PAD_R} y2={y(v)} className="stl__grid" />
            <text x={PAD_L - 6} y={y(v) + 3.5} className="stl__tick" textAnchor="end">
              {v}
            </text>
          </g>
        ))}

        <polygon points={area} className="stl__area" />
        <polyline points={line} className="stl__line" />

        {/* the mean is what the verdict uses — show where it sits */}
        <line x1={PAD_L} y1={y(fakeScore)} x2={W - PAD_R} y2={y(fakeScore)} className="stl__mean" />
        <text x={W - PAD_R} y={y(fakeScore) - 5} className="stl__meanlabel" textAnchor="end">
          mean {fakeScore.toFixed(1)}
        </text>

        {windows.map((w) => (
          <circle key={w.time} cx={x(w.time)} cy={y(w.score)} r="2.6" className="stl__dot">
            <title>{`${w.time.toFixed(1)}s — ${w.score.toFixed(1)}`}</title>
          </circle>
        ))}

        <text x={PAD_L} y={H - 6} className="stl__tick">0s</text>
        <text x={W - PAD_R} y={H - 6} className="stl__tick" textAnchor="end">
          {lastTime.toFixed(1)}s
        </text>
      </svg>

      <figcaption className="stl__cap">
        {share}% of {windows.length} windows scored above {fakeAbove}. The verdict uses
        the mean, so a clip that changes partway through can average out to the middle.
      </figcaption>
    </figure>
  );
}
