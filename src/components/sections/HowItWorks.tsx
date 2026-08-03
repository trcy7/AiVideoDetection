import { useReveal } from "../../hooks/useReveal";
import "./HowItWorks.css";

/* ---- One SVG mini-illustration per branch. No image assets. ---- */

/** Spatial: a frame with a scan grid and highlighted artifact regions. */
function SpatialArt() {
  return (
    <svg viewBox="0 0 160 120" className="branch-art branch-art--spatial" aria-hidden="true">
      <rect x="18" y="20" width="124" height="80" rx="6" className="branch-art__frame" />
      <g className="branch-art__grid">
        <line x1="59" y1="20" x2="59" y2="100" />
        <line x1="100" y1="20" x2="100" y2="100" />
        <line x1="18" y1="47" x2="142" y2="47" />
        <line x1="18" y1="73" x2="142" y2="73" />
      </g>
      <rect x="64" y="52" width="26" height="20" rx="3" className="branch-art__hit" />
      <rect x="106" y="26" width="18" height="14" rx="3" className="branch-art__hit" style={{ animationDelay: "0.5s" }} />
      <path d="M26 30v-5a4 4 0 014-4h5" className="branch-art__bracket" />
      <path d="M134 90v5a4 4 0 01-4 4h-5" className="branch-art__bracket" />
    </svg>
  );
}

/** Temporal: a filmstrip of frames tied together by recurrent arcs. */
function TemporalArt() {
  const frames = [18, 52, 86, 120];
  return (
    <svg viewBox="0 0 160 120" className="branch-art branch-art--temporal" aria-hidden="true">
      {frames.map((x, i) => (
        <rect key={x} x={x} y="52" width="26" height="34" rx="4" className="branch-art__cell" style={{ animationDelay: `${i * 0.14}s` }} />
      ))}
      <path d="M31 52C31 28 65 28 65 52" className="branch-art__arc" />
      <path d="M65 52C65 28 99 28 99 52" className="branch-art__arc" style={{ animationDelay: "0.2s" }} />
      <path d="M99 52C99 28 133 28 133 52" className="branch-art__arc" style={{ animationDelay: "0.4s" }} />
    </svg>
  );
}

/** Motion: a field of frame-to-frame difference vectors. */
function MotionArt() {
  const cells = Array.from({ length: 15 }, (_, i) => {
    const col = i % 5;
    const row = Math.floor(i / 5);
    return {
      x: 22 + col * 30,
      y: 30 + row * 32,
      angle: Math.sin(col * 0.9 + row * 0.7) * 26,
      delay: (col + row) * 0.14,
    };
  });
  return (
    <svg viewBox="0 0 160 120" className="branch-art branch-art--motion" aria-hidden="true">
      {cells.map((c, i) => (
        <g key={i} transform={`translate(${c.x} ${c.y}) rotate(${c.angle})`} style={{ animationDelay: `${c.delay}s` }}>
          <line x1="-9" y1="0" x2="7" y2="0" />
          <path d="M3 -4l6 4-6 4" />
        </g>
      ))}
    </svg>
  );
}

const BRANCHES = [
  {
    step: "01",
    title: "Spatial",
    tech: "EfficientNet-B4",
    description:
      "Reads each frame whole for generator artifacts — sliding textures, impossible detail, lighting that breaks.",
    art: <SpatialArt />,
  },
  {
    step: "02",
    title: "Temporal",
    tech: "ConvLSTM",
    description:
      "Tracks how features evolve across the clip, catching flicker, drift, and objects that morph over time.",
    art: <TemporalArt />,
  },
  {
    step: "03",
    title: "Motion",
    tech: "Frame residuals",
    description:
      "Measures frame-to-frame change. Real motion is smooth and consistent; AI motion is erratic — the variance exposes it.",
    art: <MotionArt />,
  },
];

export function HowItWorks() {
  const ref = useReveal<HTMLElement>();

  return (
    <section id="technology" className="section reveal" ref={ref}>
      <div className="container">
        <span className="hud-label section__eyebrow">Three-branch architecture</span>
        <h2 className="section__heading">How it works</h2>
        <p className="section__subheading">
          ECNet reads three independent signals from every clip — spatial,
          temporal, and motion — and fuses them into one calibrated verdict.
        </p>

        <div className="branches">
          {BRANCHES.map((branch) => (
            <article key={branch.title} className="branch-card card-hover">
              <div className="branch-card__art-frame">
                <span className="branch-card__step">{branch.step}</span>
                {branch.art}
              </div>
              <div className="branch-card__body">
                <div className="branch-card__title-row">
                  <h3 className="branch-card__title">{branch.title}</h3>
                  <span className="branch-card__tech">{branch.tech}</span>
                </div>
                <p className="branch-card__description">{branch.description}</p>
              </div>
            </article>
          ))}
        </div>

        <div className="fusion" aria-label="Fusion into a single verdict">
          <span className="fusion__node">Spatial</span>
          <span className="fusion__plus">+</span>
          <span className="fusion__node">Temporal</span>
          <span className="fusion__plus">+</span>
          <span className="fusion__node">Motion</span>
          <span className="fusion__arrow" aria-hidden="true">→</span>
          <span className="fusion__verdict">Fused verdict</span>
        </div>
      </div>
    </section>
  );
}
