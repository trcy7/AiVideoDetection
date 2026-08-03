import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  EMPTY_METADATA,
  type AnalysisResult,
  type HistoryItem,
  type VideoMetadata,
} from "../types";
import { extractVideoMetadata } from "../utils/videoMetadata";
import { captureThumbnail } from "../utils/captureThumbnail";
import { buildReportUrl, generateMockResult } from "../mock/mockData";
import { captureReportFrames } from "../utils/captureReportFrames";
import { useAnalysisHistory } from "../hooks/useAnalysisHistory";
import { PREPROCESS_STEPS } from "../components/tool/ProcessingStatus";
import { USE_REAL_BACKEND, analyzeWithBackend } from "../utils/realBackend";
import { putVideo, getVideo, deleteVideo, clearVideos, pruneVideos } from "../utils/videoStore";

/**
 * The detection flow as a small state machine, lifted to app scope so it
 * SURVIVES ROUTE CHANGES — you can navigate to /results mid-scan (or back
 * to the landing page) and the timers keep running.
 *
 *   idle ──file──▶ ready ──startAnalysis──▶ preprocessing ──▶ analyzing ──▶ done
 */
export type Phase = "idle" | "ready" | "preprocessing" | "analyzing" | "done";

const PREPROCESS_STEP_MS = 1100;
const ANALYSIS_MS = 5200;
const TICK_MS = 60;

function makeId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface ResultDisplay {
  result: AnalysisResult;
  videoUrl: string | null;
  thumbnail: string | null;
  fileSize: number;
  metadata: VideoMetadata;
  selectedId: string | null;
}

interface AnalysisContextValue {
  phase: Phase;
  file: File | null;
  videoUrl: string | null;
  metadata: VideoMetadata;
  preprocessStep: number;
  progress: number;
  result: AnalysisResult | null;
  /** Set when a real-backend request fails; cleared on retry/reset. */
  analysisError: string | null;
  /** Resolved view (live result or restored history item), null if none. */
  display: ResultDisplay | null;
  history: HistoryItem[];
  acceptFile: (file: File) => void;
  startAnalysis: () => void;
  reset: () => void;
  selectHistory: (item: HistoryItem) => void;
  removeHistory: (id: string) => void;
  clearHistory: () => void;
  onFrameRate: (fps: number) => void;
}

const Ctx = createContext<AnalysisContextValue | null>(null);

export function AnalysisProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<VideoMetadata>(EMPTY_METADATA);
  const [preprocessStep, setPreprocessStep] = useState(0);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [selectedHistory, setSelectedHistory] = useState<HistoryItem | null>(null);
  const [lastSavedId, setLastSavedId] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const metadataCleanup = useRef<(() => void) | null>(null);
  const analysisStartedAt = useRef<number>(0);
  const savedToHistory = useRef(false);
  const backendRequestStarted = useRef(false);

  const historyStore = useAnalysisHistory();

  const acceptFile = useCallback((accepted: File) => {
    metadataCleanup.current?.();
    savedToHistory.current = false;
    backendRequestStarted.current = false;
    setAnalysisError(null);
    setFile(accepted);
    setMetadata(EMPTY_METADATA);
    setResult(null);
    setThumbnail(null);
    setSelectedHistory(null);
    setProgress(0);
    setPreprocessStep(0);
    setPhase("ready");
    setVideoUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(accepted);
    });
    metadataCleanup.current = extractVideoMetadata(accepted, (patch) =>
      setMetadata((m) => ({ ...m, ...patch })),
    );
  }, []);

  const reset = useCallback(() => {
    metadataCleanup.current?.();
    metadataCleanup.current = null;
    savedToHistory.current = false;
    backendRequestStarted.current = false;
    setAnalysisError(null);
    setVideoUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setFile(null);
    setMetadata(EMPTY_METADATA);
    setResult(null);
    setThumbnail(null);
    setSelectedHistory(null);
    setProgress(0);
    setPreprocessStep(0);
    setPhase("idle");
  }, []);

  useEffect(() => () => metadataCleanup.current?.(), []);

  const onFrameRate = useCallback((fps: number) => {
    setMetadata((m) => (m.frameRate !== null ? m : { ...m, frameRate: fps }));
  }, []);

  const startAnalysis = useCallback(() => {
    if (phase !== "ready") return;
    setAnalysisError(null);
    backendRequestStarted.current = false;
    analysisStartedAt.current = performance.now();
    setPhase("preprocessing");
  }, [phase]);

  // Preprocessing: tick through the substeps, then hand off to analyzing.
  useEffect(() => {
    if (phase !== "preprocessing") return;
    if (preprocessStep >= PREPROCESS_STEPS.length) {
      setPhase("analyzing");
      return;
    }
    const timer = setTimeout(() => setPreprocessStep((s) => s + 1), PREPROCESS_STEP_MS);
    return () => clearTimeout(timer);
  }, [phase, preprocessStep]);

  // Shared by both the mock and real-backend paths: stores the result,
  // flips to "done", and (async, best-effort) captures a thumbnail and
  // persists everything to history.
  const finishAnalysis = useCallback(
    (res: AnalysisResult, fileSize: number) => {
      setResult(res);
      setPhase("done");

      const url = videoUrl;
      const blob = file;
      const snapshot = { fileSize, metadata };
      // card thumbnail + history persistence
      (url ? captureThumbnail(url) : Promise.resolve(null)).then((thumb) => {
        setThumbnail(thumb);
        const { reportUrl: _reportUrl, ...resultSansReport } = res;
        const item: HistoryItem = {
          id: makeId(),
          savedAt: new Date().toISOString(),
          thumbnail: thumb,
          fileSize: snapshot.fileSize,
          metadata: snapshot.metadata,
          result: resultSansReport,
        };
        historyStore.addItem(item);
        setLastSavedId(item.id);
        // persist the actual video so tapping this item later replays it
        if (blob) void putVideo(item.id, blob);
      });

      // richer report: top flagged frames with GradCAM, swapped in once rendered
      if (url) {
        captureReportFrames(url, res.frames, 2)
          .then((rf) => {
            if (!rf.length) return;
            const { reportUrl: prev, ...rest } = res;
            const arg = { ...rest, reportFrames: rf };
            const reportUrl = buildReportUrl(arg);
            setResult((cur) => (cur && cur.analyzedAt === res.analyzedAt ? { ...cur, reportUrl } : cur));
            URL.revokeObjectURL(prev);
          })
          .catch(() => {});
      }
    },
    [videoUrl, file, metadata, historyStore],
  );

  // Analyzing (REAL BACKEND): fire the request once on entering this phase,
  // ease the progress bar toward 92% and hold — real inference can run
  // longer than the mock's fixed animation — then jump to 100% and finish
  // whenever the response actually arrives. A failure reverts to "ready"
  // (file + metadata stay loaded) so the user can retry without re-uploading.
  useEffect(() => {
    if (phase !== "analyzing" || !USE_REAL_BACKEND) return;
    if (!file) return;

    if (!backendRequestStarted.current) {
      backendRequestStarted.current = true;
      analyzeWithBackend(file)
        .then((backend) => {
          const processingMs = Math.round(performance.now() - analysisStartedAt.current);
          const withoutReport = {
            fileName: backend.fileName,
            verdict: backend.verdict,
            confidence: backend.confidence,
            fakeScore: backend.fakeScore,
            bands: backend.bands,
            branchScores: backend.branchScores,
            indicators: [],
            frames: backend.frames,
            analyzedAt: new Date().toISOString(),
            processingMs,
            modelVersion: backend.modelVersion,
          } satisfies Omit<AnalysisResult, "reportUrl">;
          const res: AnalysisResult = { ...withoutReport, reportUrl: buildReportUrl(withoutReport) };
          setProgress(100);
          finishAnalysis(res, file.size);
        })
        .catch((err: unknown) => {
          setAnalysisError(err instanceof Error ? err.message : "Analysis failed.");
          backendRequestStarted.current = false;
          setProgress(0);
          setPreprocessStep(0);
          setPhase("ready");
        });
    }

    if (progress < 92) {
      const timer = setTimeout(
        () => setProgress((p) => Math.min(92, p + (92 * TICK_MS) / ANALYSIS_MS)),
        TICK_MS,
      );
      return () => clearTimeout(timer);
    }
  }, [phase, progress, file, finishAnalysis]);

  // Analyzing (MOCK, default): fixed-duration animated progress, then
  // produce a mock result and persist it.
  useEffect(() => {
    if (phase !== "analyzing" || USE_REAL_BACKEND) return;
    if (progress < 100) {
      const timer = setTimeout(
        () => setProgress((p) => Math.min(100, p + (100 * TICK_MS) / ANALYSIS_MS)),
        TICK_MS,
      );
      return () => clearTimeout(timer);
    }
    if (!file || savedToHistory.current) return;
    savedToHistory.current = true;

    const processingMs = Math.round(performance.now() - analysisStartedAt.current);
    const res = generateMockResult(file.name, metadata.duration, processingMs);
    finishAnalysis(res, file.size);
  }, [phase, progress, file, metadata, finishAnalysis]);

  // ---- history selection & display resolution --------------------------------

  const selectHistory = useCallback(
    (item: HistoryItem) => {
      if (phase === "preprocessing" || phase === "analyzing") return;
      setSelectedHistory(item);
    },
    [phase],
  );

  const removeHistory = useCallback(
    (id: string) => {
      historyStore.removeItem(id);
      void deleteVideo(id);
      setSelectedHistory((sel) => (sel?.id === id ? null : sel));
    },
    [historyStore],
  );

  const clearHistory = useCallback(() => {
    historyStore.clearAll();
    void clearVideos();
    setSelectedHistory(null);
  }, [historyStore]);

  // Restore the stored video for a selected history item: pull the blob from
  // IndexedDB and mint a FRESH object URL (the original blob URL is long dead).
  // Null while loading, or if this item's video wasn't stored (old item, or too
  // large) -- the viewer then falls back to the saved thumbnail.
  const [restoredVideoUrl, setRestoredVideoUrl] = useState<string | null>(null);
  useEffect(() => {
    setRestoredVideoUrl(null);
    if (!selectedHistory || selectedHistory.id === lastSavedId) return;
    let url: string | null = null;
    let cancelled = false;
    getVideo(selectedHistory.id).then((blob) => {
      if (blob && !cancelled) {
        url = URL.createObjectURL(blob);
        setRestoredVideoUrl(url);
      }
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [selectedHistory, lastSavedId]);

  // Keep IndexedDB in sync with the (capped) history list -- drop evicted blobs.
  useEffect(() => {
    void pruneVideos(historyStore.items.map((i) => i.id));
  }, [historyStore.items]);

  // Restored results need their PDF blob URL rebuilt (blob URLs don't persist).
  const restoredResult = useMemo<AnalysisResult | null>(() => {
    if (!selectedHistory) return null;
    const r = selectedHistory.result;
    const arg = {
      ...r,
      reportFrames: selectedHistory.thumbnail
        ? [{ dataUrl: selectedHistory.thumbnail, caption: "Frame - sampled from clip" }]
        : undefined,
    };
    return { ...r, reportUrl: buildReportUrl(arg) };
  }, [selectedHistory]);

  useEffect(() => {
    const url = restoredResult?.reportUrl;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [restoredResult]);

  // When the restored video is available, upgrade the report to GradCAM frames.
  const [upgradedReport, setUpgradedReport] = useState<string | null>(null);
  useEffect(() => {
    setUpgradedReport(null);
    if (!selectedHistory || !restoredVideoUrl) return;
    let url: string | null = null;
    let cancelled = false;
    captureReportFrames(restoredVideoUrl, selectedHistory.result.frames, 2)
      .then((rf) => {
        if (cancelled || !rf.length) return;
        const arg = { ...selectedHistory.result, reportFrames: rf };
        url = buildReportUrl(arg);
        setUpgradedReport(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [selectedHistory, restoredVideoUrl]);

  // Live view wins when the current analysis is what's selected (or nothing is).
  const liveActive =
    phase === "done" &&
    result !== null &&
    (selectedHistory === null || selectedHistory.id === lastSavedId);

  const display: ResultDisplay | null = liveActive
    ? {
        result: result as AnalysisResult,
        videoUrl,
        thumbnail,
        fileSize: file?.size ?? 0,
        metadata,
        selectedId: lastSavedId,
      }
    : selectedHistory && restoredResult
      ? {
          result: upgradedReport ? { ...restoredResult, reportUrl: upgradedReport } : restoredResult,
          videoUrl: restoredVideoUrl,
          thumbnail: selectedHistory.thumbnail,
          fileSize: selectedHistory.fileSize,
          metadata: selectedHistory.metadata,
          selectedId: selectedHistory.id,
        }
      : null;

  const value: AnalysisContextValue = {
    phase,
    file,
    videoUrl,
    metadata,
    preprocessStep,
    progress,
    result,
    analysisError,
    display,
    history: historyStore.items,
    acceptFile,
    startAnalysis,
    reset,
    selectHistory,
    removeHistory,
    clearHistory,
    onFrameRate,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAnalysis(): AnalysisContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAnalysis must be used within AnalysisProvider");
  return ctx;
}
