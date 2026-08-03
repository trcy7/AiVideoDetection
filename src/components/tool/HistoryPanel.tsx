import { useMemo, useState } from "react";
import type { HistoryItem } from "../../types";
import { HistoryCard } from "./HistoryCard";
import "./HistoryPanel.css";

type VerdictFilter = "all" | "real" | "fake";
type SortOrder = "newest" | "oldest";

const FILTERS: Array<{ id: VerdictFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "real", label: "Real" },
  { id: "fake", label: "AI Generated" },
];

interface HistoryPanelProps {
  items: HistoryItem[];
  selectedId: string | null;
  onSelect: (item: HistoryItem) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}

export function HistoryPanel({ items, selectedId, onSelect, onRemove, onClear }: HistoryPanelProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<VerdictFilter>("all");
  const [sort, setSort] = useState<SortOrder>("newest");

  const visible = useMemo(() => {
    let list = items;
    if (filter !== "all") list = list.filter((i) => i.result.verdict === filter);
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((i) => i.result.fileName.toLowerCase().includes(q));
    // items arrive newest-first from the hook
    return sort === "newest" ? list : [...list].reverse();
  }, [items, filter, query, sort]);

  return (
    <section className="history glass-card" aria-label="Analysis history">
      <div className="history__header">
        <div className="history__title-row">
          <h3 className="history__title">Analysis history</h3>
          <div className="history__title-actions">
            <span className="history__count">{items.length}</span>
            {items.length > 0 && (
              <button type="button" className="history__clear" onClick={onClear}>
                Clear all
              </button>
            )}
          </div>
        </div>

        <input
          type="search"
          className="history__search"
          placeholder="Search by filename…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search history by filename"
        />

        <div className="history__controls">
          <div className="history__filters" role="group" aria-label="Filter by verdict">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`history__chip${filter === f.id ? " is-active" : ""}`}
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="history__chip history__sort"
            onClick={() => setSort((s) => (s === "newest" ? "oldest" : "newest"))}
            aria-label={`Sorted by ${sort} first — click to flip`}
          >
            {sort === "newest" ? "Newest ↓" : "Oldest ↑"}
          </button>
        </div>
      </div>

      <div className="history__list">
        {visible.length === 0 ? (
          <p className="history__empty">
            {items.length === 0
              ? "No analyses yet."
              : "Nothing matches the current search/filter."}
          </p>
        ) : (
          visible.map((item, i) => (
            <div key={item.id} className="history__item" style={{ animationDelay: `${Math.min(i, 8) * 50}ms` }}>
              <HistoryCard
                item={item}
                selected={item.id === selectedId}
                onSelect={onSelect}
                onRemove={onRemove}
              />
            </div>
          ))
        )}
      </div>
    </section>
  );
}
