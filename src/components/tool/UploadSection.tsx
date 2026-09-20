import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { USE_REAL_BACKEND } from "../../utils/realBackend";
import { useAnalysis } from "../../context/AnalysisContext";
import { useReveal } from "../../hooks/useReveal";
import { UploadDropzone } from "./UploadDropzone";
import { MetadataPanel } from "./MetadataPanel";
import { HistoryPanel } from "./HistoryPanel";
import "./UploadSection.css";

const TRUST = [
  {
    label: "Up to 1 minute",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
        <path d="M12 7.5V12l3 2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    label: "Every second analyzed",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M8 5v14M16 5v14" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    ),
  },
  {
    label: "Frame-level heatmap",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    ),
  },
];

/** Landing-page upload tool — the first screen. Running an analysis hands off
 *  to /results; the state machine lives in AnalysisContext, so the scan keeps
 *  going through the navigation. */
export function UploadSection() {
  const sectionRef = useReveal<HTMLElement>();
  const navigate = useNavigate();
  const a = useAnalysis();
  const [link, setLink] = useState("");

  const inFlight = a.phase === "preprocessing" || a.phase === "analyzing";

  const runAnalysis = () => {
    a.startAnalysis();
    navigate("/results");
  };

  const openHistory = (item: Parameters<typeof a.selectHistory>[0]) => {
    a.selectHistory(item);
    navigate("/results");
  };

  return (
    <section id="analyze" className="section tool-hero reveal" ref={sectionRef}>
      <div className="tool-hero__glow" aria-hidden="true" />

      <div className="container tool">
        <div className="tool__head">
          <span className="hud-label tool__eyebrow">Forensic scanner</span>
          <h1 className="tool__title">
            Is this video <span className="gradient-text">AI-generated?</span>
          </h1>
          <p className="tool__lead">
            {USE_REAL_BACKEND
              ? "Drop a clip — ECNet scores it frame by frame and returns a verdict, a confidence score, and a heatmap of the evidence."
              : "Sample results run entirely in your browser. Connect the ECNet backend for live detection on your own clips."}
          </p>
        </div>

        <div className="tool__body">
          {a.phase === "idle" && (
            <>
              <UploadDropzone onFileAccepted={a.acceptFile} />
              {USE_REAL_BACKEND && (
                <form
                  className="tool__link"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const v = link.trim();
                    if (v) a.acceptUrl(v);
                  }}
                >
                  <label className="tool__link-label" htmlFor="clip-url">
                    or paste a link — YouTube, TikTok, Facebook
                  </label>
                  <div className="tool__link-row">
                    <input
                      id="clip-url"
                      type="url"
                      inputMode="url"
                      className="tool__link-input"
                      placeholder="https://..."
                      value={link}
                      onChange={(e) => setLink(e.target.value)}
                    />
                    <button type="submit" className="tool__link-go" disabled={!link.trim()}>
                      Fetch
                    </button>
                  </div>
                  <p className="tool__link-note">
                    Only the first minute is fetched and scored. Instagram needs a
                    login, so its links won&apos;t work.
                  </p>
                </form>
              )}
            </>
          )}

          {a.phase === "ready" && !a.file && a.sourceUrl && (
            <>
              {a.analysisError && (
                <p className="tool__error" role="alert">
                  Analysis failed: {a.analysisError}
                </p>
              )}
              <p className="tool__link-ready">
                Ready to fetch and analyze:<br />
                <span className="tool__link-url">{a.sourceUrl}</span>
              </p>
              <div className="tool__actions">
                <button type="button" className="tool__cta" onClick={runAnalysis}>
                  {a.analysisError ? "Try again" : "Run analysis"}
                </button>
                <button type="button" className="tool__ghost" onClick={a.reset}>
                  Use a different link
                </button>
              </div>
            </>
          )}

          {a.phase === "ready" && a.file && (
            <>
              {a.analysisError && (
                <p className="tool__error" role="alert">
                  Analysis failed: {a.analysisError}
                </p>
              )}
              <MetadataPanel
                fileName={a.file.name}
                fileSize={a.file.size}
                metadata={a.metadata}
                videoUrl={a.videoUrl}
                onFrameRate={a.onFrameRate}
              />
              <div className="tool__actions">
                <button type="button" className="tool__cta" onClick={runAnalysis}>
                  {a.analysisError ? "Try again" : "Run analysis"}
                </button>
                <button type="button" className="tool__ghost" onClick={a.reset}>
                  Choose a different file
                </button>
              </div>
            </>
          )}

          {inFlight && a.file && (
            <div className="tool__inflight glass-card" role="status">
              <span className="tool__inflight-pulse" aria-hidden="true" />
              <div className="tool__inflight-text">
                <strong>Analysis in progress</strong>
                <span>{a.file.name}</span>
              </div>
              <button
                type="button"
                className="tool__cta tool__cta--small"
                onClick={() => navigate("/results")}
              >
                View progress
              </button>
            </div>
          )}

          {a.phase === "done" && a.result && (
            <div className="tool__inflight glass-card">
              <span className="tool__inflight-check" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <div className="tool__inflight-text">
                <strong>Analysis complete</strong>
                <span>{a.result.fileName}</span>
              </div>
              <div className="tool__inflight-actions">
                <button
                  type="button"
                  className="tool__cta tool__cta--small"
                  onClick={() => navigate("/results")}
                >
                  View results
                </button>
                <button type="button" className="tool__ghost tool__ghost--small" onClick={a.reset}>
                  Analyze another
                </button>
              </div>
            </div>
          )}
        </div>

        {a.phase === "idle" && (
          <ul className="tool__trust" aria-label="What you get">
            {TRUST.map((item) => (
              <li key={item.label} className="tool__trust-item">
                <span className="tool__trust-icon" aria-hidden="true">{item.icon}</span>
                {item.label}
              </li>
            ))}
          </ul>
        )}

        {a.phase === "idle" && a.history.length > 0 && (
          <div className="tool__history">
            <HistoryPanel
              items={a.history}
              selectedId={null}
              onSelect={openHistory}
              onRemove={a.removeHistory}
              onClear={a.clearHistory}
            />
          </div>
        )}
      </div>
    </section>
  );
}
