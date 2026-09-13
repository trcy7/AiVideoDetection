import { useEffect, useState } from "react";
import { sendFeedback, type FeedbackLabel } from "../../utils/realBackend";
import "./FeedbackCard.css";

interface FeedbackCardProps {
  /** Audit-trail id from the backend; the card hides itself without one. */
  analysisId?: string | null;
}

const OPTIONS: Array<{ label: FeedbackLabel; text: string }> = [
  { label: "real", text: "Real footage" },
  { label: "ai_generated", text: "AI generated" },
  { label: "unsure", text: "Not sure" },
];

/** Ground-truth collector: what the clip ACTUALLY was. Feeds the server's
 *  feedback table so real-world accuracy can be measured against uploads. */
export function FeedbackCard({ analysisId }: FeedbackCardProps) {
  const [sent, setSent] = useState<FeedbackLabel | null>(null);
  const [busy, setBusy] = useState<FeedbackLabel | null>(null);
  const [error, setError] = useState<string | null>(null);

  // a new analysis resets the card
  useEffect(() => {
    setSent(null);
    setBusy(null);
    setError(null);
  }, [analysisId]);

  if (!analysisId) return null;

  const submit = async (label: FeedbackLabel) => {
    setBusy(label);
    setError(null);
    try {
      await sendFeedback(analysisId, label);
      setSent(label);
    } catch {
      setError("Couldn't save that — try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="feedback glass-card" aria-label="Report the true label">
      <div className="feedback__text">
        <h3>Do you know what this video really was?</h3>
        <p>
          {sent
            ? "Recorded — thank you. This helps measure real-world accuracy."
            : "Optional. Your answer is stored as ground truth to evaluate the model."}
        </p>
      </div>

      {sent ? (
        <span className="feedback__done">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Saved
        </span>
      ) : (
        <div className="feedback__actions">
          {OPTIONS.map((opt) => (
            <button
              key={opt.label}
              type="button"
              className={`feedback__btn feedback__btn--${opt.label}`}
              onClick={() => submit(opt.label)}
              disabled={busy !== null}
            >
              {busy === opt.label ? "Saving…" : opt.text}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="feedback__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
