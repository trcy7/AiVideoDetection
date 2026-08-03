import type { HistoryItem, Verdict } from "../../types";
import "./HistoryPanel.css";

const VERDICT_SHORT: Record<Verdict, string> = {
  real: "Real",
  fake: "AI Gen",
  uncertain: "Uncertain",
};

function shortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " · " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

interface HistoryCardProps {
  item: HistoryItem;
  selected: boolean;
  onSelect: (item: HistoryItem) => void;
  onRemove: (id: string) => void;
}

export function HistoryCard({ item, selected, onSelect, onRemove }: HistoryCardProps) {
  const { result } = item;
  return (
    <div className={`hcard hcard--${result.verdict}${selected ? " is-selected" : ""}`}>
      <button
        type="button"
        className="hcard__body"
        onClick={() => onSelect(item)}
        aria-pressed={selected}
        aria-label={`Open analysis of ${result.fileName}: ${VERDICT_SHORT[result.verdict]}, ${Math.round(result.confidence)} percent confidence`}
      >
        <span className="hcard__thumb" aria-hidden="true">
          {item.thumbnail ? (
            <img src={item.thumbnail} alt="" loading="lazy" />
          ) : (
            <svg viewBox="0 0 24 24" fill="none">
              <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10 9.5l5 2.5-5 2.5v-5z" fill="currentColor" />
            </svg>
          )}
        </span>

        <span className="hcard__text">
          <span className="hcard__name" title={result.fileName}>
            {result.fileName}
          </span>
          <span className="hcard__row">
            <span className={`hcard__verdict hcard__verdict--${result.verdict}`}>
              {VERDICT_SHORT[result.verdict]}
            </span>
            <span className="hcard__confidence">{Math.round(result.confidence)}%</span>
          </span>
          <span className="hcard__row hcard__row--meta">
            <span>{shortDate(item.savedAt)}</span>
            <span>{(result.processingMs / 1000).toFixed(1)}s</span>
          </span>
        </span>
      </button>

      <button
        type="button"
        className="hcard__delete"
        onClick={() => onRemove(item.id)}
        aria-label={`Delete history entry for ${result.fileName}`}
        title="Delete"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
