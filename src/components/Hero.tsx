import "./Hero.css";

const CHIPS = [
  "Sora · Pika · Kling & more",
  "Frame-level heatmaps",
  "Whole-frame forensics",
  "Explainable verdicts",
];

/** Detection viewport: drop a clip at public/hero-demo.mp4 and it loops here,
 *  framed as a scanner (scan line, HUD brackets, bounding box, telemetry). */
function VideoScanner() {
  return (
    <div className="hero-video">
      <video
        className="hero-video__media"
        src="/hero-demo.mp4"
        autoPlay
        loop
        muted
        playsInline
        aria-label="Demo clip being analyzed for AI-generation artifacts"
      />
      <div className="hero-video__grid" aria-hidden="true" />
      <div className="hero-video__box" aria-hidden="true" />
      <div className="hero-video__scan" aria-hidden="true" />
      <div className="hero-video__corners" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
      <span className="hero-video__badge" aria-hidden="true">
        <span className="hero-video__badge-dot" />
        ANALYZING
      </span>
      <span className="hero-video__telemetry" aria-hidden="true">
        SPATIAL ✓ · TEMPORAL ✓ · MOTION ✓
      </span>
    </div>
  );
}

export function Hero() {
  return (
    <section className="hero" id="top">
      <div className="hero__backdrop" aria-hidden="true" />
      <div className="hero__glow" aria-hidden="true" />

      <div className="container hero__inner">
        <div className="hero__content">
          <span className="hud-label hero__eyebrow">AI-generated video detection</span>
          <h1 className="hero__title">
            See through synthetic video with{" "}
            <span className="hero__title-accent">ECNet</span>
          </h1>
          <p className="hero__lead">
            Video generators leave traces — sliding textures, morphing
            backgrounds, physics that doesn't hold. ECNet reads every frame and
            returns a verdict, a confidence score, and a heatmap of the evidence.
          </p>

          <ul className="hero__chips" aria-label="Key capabilities">
            {CHIPS.map((chip) => (
              <li key={chip} className="hero__chip">
                <span className="hero__chip-dot" aria-hidden="true" />
                {chip}
              </li>
            ))}
          </ul>

          <div className="hero__actions">
            <a className="hero__cta" href="#analyze">
              Analyze a video
            </a>
            <a className="hero__secondary" href="#technology">
              How it works
            </a>
          </div>
        </div>

        <div className="hero__visual">
          <VideoScanner />
        </div>
      </div>
    </section>
  );
}
