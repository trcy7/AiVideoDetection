import { useNavigate } from "react-router-dom";
import { USE_REAL_BACKEND } from "../../utils/realBackend";
import { useAnalysis } from "../../context/AnalysisContext";
import { useReveal } from "../../hooks/useReveal";
import { UploadDropzone } from "./UploadDropzone";
import { MetadataPanel } from "./MetadataPanel";
import { HistoryPanel } from "./HistoryPanel";
import "./UploadSection.css";

/** Landing-page upload tool. Running an analysis hands off to /results —
 *  the state machine lives in AnalysisContext, so the scan keeps going
 *  through the navigation. */
export function UploadSection() {
  const sectionRef = useReveal<HTMLElement>();
  const navigate = useNavigate();
  const a = useAnalysis();

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
    <section id="analyze" className="section reveal" ref={sectionRef}>
      <div className="container tool">
        <span className="hud-label section__eyebrow">Forensic scanner</span>
        <h2 className="section__heading">Analyze a video</h2>
        <p className="section__subheading">
          {USE_REAL_BACKEND
            ? "Upload a clip up to one minute — ECNet scores it frame by frame and returns a verdict, confidence score, and heatmap of the evidence."
            : "Sample results run entirely in your browser. Connect the ECNet backend for live detection on your own clips."}
        </p>

        <div className="tool__body">
          {a.phase === "idle" && <UploadDropzone onFileAccepted={a.acceptFile} />}

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

          {a.phase === "idle" && a.history.length > 0 && (
            <HistoryPanel
              items={a.history}
              selectedId={null}
              onSelect={openHistory}
              onRemove={a.removeHistory}
              onClear={a.clearHistory}
            />
          )}
        </div>
      </div>
    </section>
  );
}
