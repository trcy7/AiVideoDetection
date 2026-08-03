import { useReveal } from "../../hooks/useReveal";
import "./FAQ.css";

const FAQS: Array<{ q: string; a: string }> = [
  {
    q: "What kinds of video can ECNet detect?",
    a: "Version 1 targets fully AI-generated video — clips produced by generators like Sora, Pika, Kling, Runway, and open-source models. Face-swap deepfake detection is on the roadmap (v2). It is not designed to catch conventional edits like cuts, splices, or color grading.",
  },
  {
    q: "How accurate is the detection?",
    a: "No detector is perfect, which is why every verdict ships with a confidence score, per-branch evidence, and an explainable heatmap. Treat the output as strong evidence to weigh, not as final proof — especially in the Uncertain band, and especially for generators the model hasn't seen before.",
  },
  {
    q: "What does the confidence score actually mean?",
    a: "It reflects how decisive and consistent the evidence is across the sampled frames. A 95% 'AI Generated' means nearly every frame showed strong generation traces; a 55% verdict means the frames disagreed and a human should review the heatmap.",
  },
  {
    q: "Is my video uploaded to a server?",
    a: "In this preview build, nothing leaves your browser — file inspection, metadata, and the mock analysis all run locally. When the detection backend launches, videos will be processed server-side and deleted after analysis; the privacy policy will spell out retention exactly.",
  },
  {
    q: "Why does the heatmap matter if I already have a verdict?",
    a: "Because it makes the decision auditable. The GradCAM overlay shows which regions drove the score — if it highlights a morphing background, sliding texture, or a watermark ghost, you can see the evidence yourself; if it's reacting to compression noise, you'll see that too and can discount the verdict.",
  },
  {
    q: "What video formats and sizes are supported?",
    a: "MP4, MOV, WebM, MKV, and AVI files up to 500 MB. Very low-resolution or heavily re-compressed clips can still be analyzed, but detection confidence drops when the traces the model relies on have been smoothed away.",
  },
];

export function FAQ() {
  const ref = useReveal<HTMLElement>();

  return (
    <section id="faq" className="section reveal" ref={ref}>
      <div className="container faq">
        <span className="hud-label section__eyebrow">Support</span>
        <h2 className="section__heading">Frequently asked questions</h2>

        <div className="faq__list">
          {FAQS.map((item) => (
            <details key={item.q} className="faq__item">
              <summary className="faq__question">
                {item.q}
                <svg
                  className="faq__chevron"
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M4 6l4 4 4-4"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </summary>
              <p className="faq__answer">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
