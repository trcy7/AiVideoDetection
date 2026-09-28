import { useReveal } from "../../hooks/useReveal";
import "./FAQ.css";

const FAQS: Array<{ q: string; a: string }> = [
  {
    q: "What kinds of video can ECNet detect?",
    a: "Fully AI-generated video. The model was trained on 13 generators, including Sora 2, Veo 3.1, Kling 2.6, Wan, Seedance, LTX-2, Ovi and Emu 3.5. It does not detect face-swap deepfakes, and it does not flag conventional editing such as cuts, splices or colour grading.",
  },
  {
    q: "How accurate is the detection?",
    a: "ECNet-7 scores 0.93 AUC and 84.9% balanced accuracy across 3,453 validation videos. Accuracy is lower on generators absent from training, since those leave artifacts the model has not seen. Scores near the thresholds are returned as Uncertain rather than forced to a verdict.",
  },
  {
    q: "What does the confidence score actually mean?",
    a: "Confidence combines two measures: how far the score sits from the decision threshold, and how closely the analysed frames agree with each other. It is distinct from the score itself. A clip can score high with low confidence when only part of it carries artifacts.",
  },
  {
    q: "Is my video uploaded to a server?",
    a: "The clip is sent to the ECNet inference server, analysed, and deleted once the analysis completes; it is never written to permanent storage. What is kept is the verdict metadata and a SHA-256 hash of the file, so a repeat scan can be recognised without retaining the video itself. File inspection and metadata still run locally in your browser.",
  },
  {
    q: "Why does the heatmap matter if I already have a verdict?",
    a: "The GradCAM overlay marks the regions that raised the score, making the verdict auditable rather than asserted. Regions are drawn only where generation artifacts were detected; a clip returned as Real shows none.",
  },
  {
    q: "Which links are supported?",
    a: "YouTube, TikTok and Facebook links to publicly accessible videos, up to 60 seconds. Instagram is not supported because its posts require an authenticated session. Links to images, audio or private videos are rejected.",
  },
  {
    q: "What video formats and sizes are supported?",
    a: "MP4, MOV, WebM, MKV and AVI, up to 500 MB and 60 seconds. Heavily compressed or very low-resolution clips are accepted, but confidence falls as compression removes the artifacts the model depends on.",
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
