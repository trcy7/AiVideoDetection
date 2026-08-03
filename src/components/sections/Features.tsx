import { useReveal } from "../../hooks/useReveal";
import "./Features.css";

const HeatmapIcon = (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

const FilmIcon = (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
    <path d="M8 5v14M16 5v14" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

const ClockIcon = (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
    <path d="M12 7.5V12l3 2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const MotionIcon = (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M3 12h3l2.4-6 3.4 13 2.9-9 2 5H21"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** Mini GradCAM-style heatmap: a cell grid with a glowing hotspot + a
 *  dashed detection box that slowly tracks. Purely decorative. */
function HeatmapViz() {
  const cols = 14;
  const rows = 4;
  const hx = 4.2;
  const hy = 1.6;
  const cells = Array.from({ length: cols * rows }, (_, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const d = Math.hypot(c - hx, (r - hy) * 1.6);
    const heat = Math.max(0, 1 - d / 4.5);
    return { x: 4 + c * 20, y: 4 + r * 19, o: 0.05 + heat * 0.62 };
  });
  return (
    <div className="feature-viz" aria-hidden="true">
      <svg viewBox="0 0 288 84" className="feature-viz__svg">
        {cells.map((cell, i) => (
          <rect
            key={i}
            className="feature-viz__cell"
            x={cell.x}
            y={cell.y}
            width="16"
            height="15"
            rx="3"
            style={{ opacity: cell.o }}
          />
        ))}
        <rect className="feature-viz__box" x="52" y="10" width="64" height="46" rx="5" />
      </svg>
    </div>
  );
}

export function Features() {
  const ref = useReveal<HTMLElement>();

  return (
    <section id="features" className="section reveal" ref={ref}>
      <div className="container">
        <span className="hud-label section__eyebrow">Capabilities</span>
        <h2 className="section__heading">Built for scrutiny</h2>
        <p className="section__subheading">
          Detection you can interrogate, not a black box.
        </p>

        <div className="features">
          <article className="feature-card feature-card--hero card-hover">
            <div className="feature-card__top">
              <div className="feature-card__icon feature-card__icon--lg">{HeatmapIcon}</div>
              <span className="hud-label feature-card__tag">GradCAM</span>
            </div>
            <h3 className="feature-card__title">Explainable heatmaps</h3>
            <p className="feature-card__description">
              Overlays show exactly which regions drove the verdict — judge the
              evidence yourself instead of trusting a bare score.
            </p>
            <HeatmapViz />
          </article>

          <article className="feature-card card-hover">
            <div className="feature-card__icon">{FilmIcon}</div>
            <h3 className="feature-card__title">Frame-by-frame</h3>
            <p className="feature-card__description">
              Every sampled frame is scored on its own, so generated segments
              spliced into real footage still get caught.
            </p>
          </article>

          <article className="feature-card card-hover">
            <div className="feature-card__icon">{ClockIcon}</div>
            <h3 className="feature-card__title">Temporal consistency</h3>
            <p className="feature-card__description">
              Scenes are tracked across time for the flicker, morphing, and
              drift generators struggle to hold steady.
            </p>
          </article>

          <article className="feature-card feature-card--wide card-hover">
            <div className="feature-card__icon">{MotionIcon}</div>
            <div className="feature-card__wide-body">
              <h3 className="feature-card__title">Motion &amp; flicker analysis</h3>
              <p className="feature-card__description">
                Frame-to-frame residuals measure how the picture changes. Real
                motion is smooth and consistent; AI motion is erratic — the
                variance gives it away.
              </p>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
