import { Link, useNavigate } from "react-router-dom";
import { useAnalysis } from "../context/AnalysisContext";
import { ResultsView } from "../components/tool/ResultsView";
import { HistoryPanel } from "../components/tool/HistoryPanel";
import {
  AnalyzingStatus,
  PreprocessingStatus,
  PREPROCESS_STEPS,
} from "../components/tool/ProcessingStatus";
import "./ResultsPage.css";

/** Dedicated forensic-report workspace at /results.
 *  Three states: scanning (live progress), report (results), and an
 *  empty state with history for direct visits/refreshes. */
export function ResultsPage() {
  const navigate = useNavigate();
  const a = useAnalysis();

  const inFlight = a.phase === "preprocessing" || a.phase === "analyzing";

  return (
    <div className="rpage">
      <div className="container">
        <div className="rpage__topbar">
          <Link className="rpage__back" to="/#analyze">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            New analysis
          </Link>
          <span className="hud-label rpage__crumb">Forensic report</span>
        </div>

        {inFlight && (a.file || a.sourceUrl) && (
          <div className="rpage__scanning">
            <div className="rpage__scanning-head">
              <h1 className="rpage__title">Scanning video</h1>
              <p className="rpage__subtitle rpage__filename">
                {a.file ? a.file.name : a.sourceUrl}
              </p>
            </div>

            <div className="scan">
              <div className="scan__viewport">
                {a.videoUrl ? (
                  <video
                    className="scan__video"
                    src={a.videoUrl}
                    autoPlay
                    loop
                    muted
                    playsInline
                    aria-hidden="true"
                  />
                ) : (
                  <div className="scan__video scan__video--empty" aria-hidden="true" />
                )}
                <div className="scan__grid" aria-hidden="true" />
                <div className="scan__line" aria-hidden="true" />
                <div className="scan__corners" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
                <span className="scan__badge" aria-hidden="true">
                  <span className="scan__badge-dot" />
                  ANALYZING
                  {a.phase === "analyzing" ? ` · ${Math.round(a.progress)}%` : ""}
                </span>
              </div>

              <div className="scan__panel">
                <PreprocessingStatus
                  activeStep={a.phase === "preprocessing" ? a.preprocessStep : PREPROCESS_STEPS.length}
                />
                {a.phase === "analyzing" && <AnalyzingStatus progress={a.progress} />}
              </div>
            </div>
          </div>
        )}

        {!inFlight && a.display && (
          <>
            <ResultsView
              result={a.display.result}
              videoUrl={a.display.videoUrl}
              thumbnail={a.display.thumbnail}
              fileSize={a.display.fileSize}
              metadata={a.display.metadata}
              history={a.history}
              selectedHistoryId={a.display.selectedId}
              onSelectHistory={a.selectHistory}
              onRemoveHistory={a.removeHistory}
              onClearHistory={a.clearHistory}
            />
            <div className="rpage__actions">
              <button
                type="button"
                className="tool__ghost"
                onClick={() => {
                  a.reset();
                  navigate("/#analyze");
                }}
              >
                Analyze another video
              </button>
            </div>
          </>
        )}

        {!inFlight && !a.display && a.analysisError && a.file && (
          <div className="rpage__empty">
            <div className="rpage__empty-card rpage__empty-card--error glass-card">
              <span className="rpage__empty-icon rpage__empty-icon--error" aria-hidden="true">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                  <path d="M12 8v5M12 16.5h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              </span>
              <h1 className="rpage__title">Analysis failed</h1>
              <p className="rpage__subtitle rpage__error-detail">{a.analysisError}</p>
              <div className="rpage__error-actions">
                <button type="button" className="tool__cta" onClick={a.startAnalysis}>
                  Try again
                </button>
                <button
                  type="button"
                  className="tool__ghost"
                  onClick={() => {
                    a.reset();
                    navigate("/#analyze");
                  }}
                >
                  Choose a different file
                </button>
              </div>
            </div>
          </div>
        )}

        {!inFlight && !a.display && !(a.analysisError && a.file) && (
          <div className="rpage__empty">
            <div className="rpage__empty-card glass-card">
              <span className="rpage__empty-icon" aria-hidden="true">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                  <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M10 9.5l5 2.5-5 2.5v-5z" fill="currentColor" />
                </svg>
              </span>
              <h1 className="rpage__title">No report open</h1>
              <p className="rpage__subtitle">
                Run a scan to generate a forensic report, or reopen a past
                analysis below.
              </p>
              <Link className="tool__cta rpage__empty-cta" to="/#analyze">
                Analyze a video
              </Link>
            </div>

            {a.history.length > 0 && (
              <HistoryPanel
                items={a.history}
                selectedId={null}
                onSelect={a.selectHistory}
                onRemove={a.removeHistory}
                onClear={a.clearHistory}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
