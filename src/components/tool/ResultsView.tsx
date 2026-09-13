import type { AnalysisResult, HistoryItem, VideoMetadata } from "../../types";
import { ResultHeader } from "./ResultHeader";
import { VideoPreview } from "./VideoPreview";
import { ConfidenceGauge } from "./ConfidenceGauge";
import { VerdictCard } from "./VerdictCard";
import { HistoryPanel } from "./HistoryPanel";
import { HeatmapViewer } from "./HeatmapViewer";
import { FeedbackCard } from "./FeedbackCard";
import "./ResultsView.css";

interface ResultsViewProps {
  result: AnalysisResult;
  videoUrl: string | null;
  thumbnail: string | null;
  fileSize: number;
  metadata: VideoMetadata;
  history: HistoryItem[];
  selectedHistoryId: string | null;
  onSelectHistory: (item: HistoryItem) => void;
  onRemoveHistory: (id: string) => void;
  onClearHistory: () => void;
}

/** Results layout: header on top; video preview + verdict/gauge in the left
 *  column, GradCAM wide on the right; analysis history FULL-WIDTH below the
 *  results (it's secondary to the verdict evidence). Mobile: single column. */
export function ResultsView({
  result,
  videoUrl,
  thumbnail,
  fileSize,
  metadata,
  history,
  selectedHistoryId,
  onSelectHistory,
  onRemoveHistory,
  onClearHistory,
}: ResultsViewProps) {
  return (
    <div className="rview" role="region" aria-label="Analysis results">
      <div className="rview__header">
        <ResultHeader result={result} />
      </div>

      <div className="rview__left">
        <section className="rview__verdict glass-card" aria-label="Detection verdict">
          <ConfidenceGauge score={result.fakeScore} verdict={result.verdict} bands={result.bands} />
          <VerdictCard result={result} />
        </section>

        <VideoPreview
          fileName={result.fileName}
          fileSize={fileSize}
          metadata={metadata}
          verdict={result.verdict}
          frameCount={result.frames.length}
          videoUrl={videoUrl}
          thumbnail={thumbnail}
        />
      </div>

      <div className="rview__main">
        <section className="rview__heatmap glass-card" aria-label="GradCAM heatmap">
          <div className="rview__heatmap-header">
            <h3>GradCAM heatmap</h3>
            <p>Red marks flagged regions.</p>
          </div>
          <HeatmapViewer frames={result.frames} videoUrl={videoUrl} thumbnail={thumbnail} />
        </section>
      </div>

      <section className="rview__report glass-card" aria-label="Detection report">
        <div className="rview__report-text">
          <h3>Detection report</h3>
          <p>Full results as a PDF.</p>
        </div>
        <div className="rview__report-actions">
          <a
            className="rview__report-btn rview__report-btn--primary"
            href={result.reportUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            View report
          </a>
          <a
            className="rview__report-btn"
            href={result.reportUrl}
            download={`${result.fileName.replace(/\.[^/.]+$/, "")}-ecnet-report.pdf`}
          >
            Download PDF
          </a>
        </div>
      </section>

      <FeedbackCard analysisId={result.analysisId} />

      <div className="rview__history">
        <HistoryPanel
          items={history}
          selectedId={selectedHistoryId}
          onSelect={onSelectHistory}
          onRemove={onRemoveHistory}
          onClear={onClearHistory}
        />
      </div>
    </div>
  );
}
