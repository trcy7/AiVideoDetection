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
import { captureReportFrames, reportFramesFromStills } from "../utils/captureReportFrames";
import { useAnalysisHistory } from "../hooks/useAnalysisHistory";
import { PREPROCESS_STEPS } from "../components/tool/ProcessingStatus";
import {
  USE_REAL_BACKEND,
  analyzeWithBackend,
  analyzeUrlWithBackend,
  resolveUrlMeta,
  fetchPreviewClip,
  type LinkMeta,
} from "../utils/realBackend";
import { putVideo, getVideo, deleteVideo, clearVideos, pruneVideos } from "../utils/videoStore";
import { MAX_DURATION_SECONDS } from "../utils/validateVideoFile";

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
  /** Analyze a pasted link instead of a local file; starts immediately. */
  analyzeUrl: (url: string) => void;
  sourceUrl: string | null;
  /** Title/poster for the pasted link; null until resolved, or if it failed. */
  sourceMeta: LinkMeta | null;
  /** Object URL of a short preview clip for the scanning view; null if none. */
  previewUrl: string | null;
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
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [sourceMeta, setSourceMeta] = useState<LinkMeta | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<VideoMetadata>(EMPTY_METADATA);
  const [preprocessStep, setPreprocessStep] = useState(0);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [selectedHistory, setSelectedHistory] = useState<HistoryItem | null>(null);
  const [lastSavedId, setLastSavedId] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  // the preview clip's blob, kept so a link analysis has something to store as
  // its history video -- there is no local file to fall back on
  const previewBlob = useRef<Blob | null>(null);
  const metadataCleanup = useRef<(() => void) | null>(null);
  const analysisStartedAt = useRef<number>(0);
  const savedToHistory = useRef(false);
  const backendRequestStarted = useRef(false);
  /** Generation counter for the CURRENT source. Every async callback below
   *  captures it and bails if it has moved on -- without this, the preview and
   *  metadata of a link the user already navigated away from land on the new
   *  one, which is why analysing a second link showed the FIRST link's video.
   *  A boolean "in flight" flag cannot express this: two runs overlap. */
  const runId = useRef(0);

  const historyStore = useAnalysisHistory();

  const dropPreview = useCallback(() => {
    previewBlob.current = null;
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  const acceptFile = useCallback((accepted: File) => {
    runId.current += 1;                 // supersede anything still in flight
    metadataCleanup.current?.();
    savedToHistory.current = false;
    backendRequestStarted.current = false;
    setAnalysisError(null);
    setFile(accepted);
    setSourceUrl(null);
    setSourceMeta(null);
    dropPreview();
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
  }, [dropPreview]);

  /** Same reset as acceptFile, but the source is a link: no File, no object
   *  URL, so the heatmap falls back to its placeholder (nothing to draw).
   *
   *  Goes STRAIGHT to preprocessing rather than parking at "ready". A dropped
   *  file has metadata worth confirming -- duration, resolution, a thumbnail --
   *  but a link has none of that yet, so the confirm step would show only the
   *  URL the user just typed and ask them to click again. On failure the flow
   *  still falls back to "ready", which is where the retry lives. */
  const analyzeUrl = useCallback((url: string) => {
    const myRun = (runId.current += 1);   // this link's generation
    metadataCleanup.current?.();
    metadataCleanup.current = null;
    savedToHistory.current = false;
    backendRequestStarted.current = false;
    setAnalysisError(null);
    setFile(null);
    setVideoUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setMetadata(EMPTY_METADATA);
    setResult(null);
    setThumbnail(null);
    setSelectedHistory(null);
    setProgress(0);
    setPreprocessStep(0);
    setSourceUrl(url);
    setSourceMeta(null);
    dropPreview();
    // both run in parallel with the analysis and only feed the scanning view,
    // so a failure in either must change nothing about the run
    // ONE resolve, then the preview -- chained, not parallel. Each of these is
    // a separate request to the platform, and firing them together from one
    // datacenter IP is what gets the connection reset.
    void resolveUrlMeta(url)
      .then((m) => {
        // The user may have pasted another link while this one was resolving.
        // Writing m here would show the OLD clip's duration and resolution
        // against the new link, and would queue the old preview behind it.
        if (runId.current !== myRun) return null;
        setSourceMeta(m);
        // The same limit uploads are held to. The server rejects it anyway,
        // but only after the analysis has been queued -- catching it here
        // saves the user the wait and the backend the work.
        if (m?.durationSec && m.durationSec > MAX_DURATION_SECONDS) {
          setAnalysisError(
            `That video is ${Math.round(m.durationSec)}s. Only clips up to ` +
              `${MAX_DURATION_SECONDS}s are analysed.`,
          );
          backendRequestStarted.current = true;   // stop the pending request
          setProgress(0);
          setPreprocessStep(0);
          setPhase("ready");
          return null;
        }
        if (m) {
          setMetadata({
            duration: m.durationSec,
            width: m.width,
            height: m.height,
            frameRate: null,      // not reported by the extractor
            codec: null,
          });
        }
        return fetchPreviewClip(url);
      })
      .then((blob) => {
        if (!blob) return;
        // THE BUG this guard fixes: a preview can take tens of seconds to fetch
        // and transcode. Without it, the previous link's clip arrives after the
        // user has started a new one and is painted as the new one's video.
        // Drop the blob rather than leak an object URL for it.
        if (runId.current !== myRun) return;
        previewBlob.current = blob;
        setPreviewUrl(URL.createObjectURL(blob));
      });
    analysisStartedAt.current = performance.now();
    setPhase("preprocessing");
  }, [dropPreview]);

  const reset = useCallback(() => {
    runId.current += 1;                 // abandon anything still resolving
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
    setSourceUrl(null);
    setSourceMeta(null);
    dropPreview();
    setMetadata(EMPTY_METADATA);
    setResult(null);
    setThumbnail(null);
    setSelectedHistory(null);
    setProgress(0);
    setPreprocessStep(0);
    setPhase("idle");
  }, [dropPreview]);

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

      // a link has no local file, so both the thumbnail grab and the stored
      // history clip fall back to the preview the scanning view fetched
      const url = videoUrl ?? previewUrl;
      const blob: Blob | null = file ?? previewBlob.current;
      const snapshot = { fileSize, metadata };
      // card thumbnail + history persistence
      const poster = sourceMeta?.thumbnail ?? null;
      (url ? captureThumbnail(url) : Promise.resolve(null)).then((grabbed) => {
        const thumb = grabbed ?? poster;
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

      // richer report: top flagged frames with GradCAM, swapped in once rendered.
      // Server stills win when present -- they always render, while the video
      // path needs the browser to decode the source and yields nothing for links.
      const stills = res.frames.some((f) => f.image);
      if (stills || url) {
        (stills ? reportFramesFromStills(res.frames, 2) : captureReportFrames(url as string, res.frames, 2))
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
    // sourceMeta and previewUrl resolve asynchronously after analyzeUrl starts,
    // so omitting them here would capture the nulls they held at render and link
    // history rows would get no image and no clip
    [videoUrl, previewUrl, file, metadata, historyStore, sourceMeta],
  );

  // Analyzing (REAL BACKEND): fire the request once on entering this phase,
  // ease the progress bar toward 92% and hold — real inference can run
  // longer than the mock's fixed animation — then jump to 100% and finish
  // whenever the response actually arrives. A failure reverts to "ready"
  // (file + metadata stay loaded) so the user can retry without re-uploading.
  useEffect(() => {
    if (phase !== "analyzing" || !USE_REAL_BACKEND) return;
    if (!file && !sourceUrl) return;

    if (!backendRequestStarted.current) {
      backendRequestStarted.current = true;
      const myRun = runId.current;      // the source this request belongs to
      (file ? analyzeWithBackend(file) : analyzeUrlWithBackend(sourceUrl as string))
        .then((backend) => {
          // A verdict for a source the user has moved on from must not be
          // shown, scored, or written to history against the new one.
          if (runId.current !== myRun) return;
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
            windows: backend.windows,
            analyzedAt: new Date().toISOString(),
            processingMs,
            modelVersion: backend.modelVersion,
            analysisId: backend.analysisId ?? null,
          } satisfies Omit<AnalysisResult, "reportUrl">;
          const res: AnalysisResult = { ...withoutReport, reportUrl: buildReportUrl(withoutReport) };
          setProgress(100);
          finishAnalysis(res, file?.size ?? 0);
        })
        .catch((err: unknown) => {
          if (runId.current !== myRun) return;   // stale failure, not this source's
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
  }, [phase, progress, file, sourceUrl, finishAnalysis]);

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
      runId.current += 1;               // a history pick supersedes a pending fetch
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
        videoUrl: videoUrl ?? previewUrl,
        thumbnail: thumbnail ?? sourceMeta?.thumbnail ?? null,
        fileSize: file?.size ?? sourceMeta?.filesize ?? 0,
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
    sourceUrl,
    sourceMeta,
    previewUrl,
    analyzeUrl,
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
