import { useCallback, useState } from "react";
import type { HistoryItem } from "../types";

const STORAGE_KEY = "ecnet-history-v1";
const MAX_ITEMS = 20;

function readStorage(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStorage(items: HistoryItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Quota exceeded (thumbnails add up) — drop oldest and retry once.
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, 10)));
    } catch {
      /* give up quietly; history is a convenience, not critical data */
    }
  }
}

/** localStorage-backed list of past analyses, newest first, capped. */
export function useAnalysisHistory() {
  const [items, setItems] = useState<HistoryItem[]>(readStorage);

  const addItem = useCallback((item: HistoryItem) => {
    setItems((prev) => {
      const next = [item, ...prev].slice(0, MAX_ITEMS);
      writeStorage(next);
      return next;
    });
  }, []);

  const removeItem = useCallback((id: string) => {
    setItems((prev) => {
      const next = prev.filter((i) => i.id !== id);
      writeStorage(next);
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    setItems(() => {
      writeStorage([]);
      return [];
    });
  }, []);

  return { items, addItem, removeItem, clearAll };
}
