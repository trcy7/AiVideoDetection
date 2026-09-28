import type { AnalysisResult, HistoryItem, VideoMetadata } from "../../types";
import { ResultHeader } from "./ResultHeader";
import { VideoPreview } from "./VideoPreview";
import { VerdictCard } from "./VerdictCard";
import { DetectorCard } from "./DetectorCard";
import { HistoryPanel } from "./HistoryPanel";
import { HeatmapViewer } from "./HeatmapViewer";
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
  onAnalyzeAnother: () => void;
}

/** Report layout: head and verdict run full width, then frame evidence on the
 *  left with the branch breakdown and video details stacked beside it, and
 *  history below. Tablet drops to one column with the two side cards paired;
 *  phone stacks everything. */
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
  onAnalyzeAnother,
}: ResultsViewProps) {
  return (
    <div className="rview" role="region" aria-label="Analysis results">
      <ResultHeader result={result} onAnalyzeAnother={onAnalyzeAnother} />

      <VerdictCard result={result} />

      <div className="rview__main">
        <section className="rview__evidence glass-card" aria-labelledby="rview-evidence-title">
          <div className="rview__evidence-head">
            <h2 id="rview-evidence-title" className="rview__h2">GradCAM heatmap</h2>
            <p className="rview__sub">Per-frame activation map. Red marks flagged regions.</p>
          </div>
          <HeatmapViewer frames={result.frames} videoUrl={videoUrl} thumbnail={thumbnail} />
        </section>

        <div className="rview__side">
          <DetectorCard result={result} />
          <VideoPreview
            fileName={result.fileName}
            fileSize={fileSize}
            metadata={metadata}
            verdict={result.verdict}
            videoUrl={videoUrl}
            thumbnail={thumbnail}
          />
        </div>
      </div>

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
