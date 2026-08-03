import type {
  AnalysisResult,
  BranchScores,
  HeatmapBox,
  HeatmapFrame,
  Indicator,
  ReportFrame,
  Verdict,
} from "../types";
import { cleanModelVersion } from "../utils/realBackend";

export const FRAME_COUNT = 32;
export const MODEL_VERSION = "ECNet-7";

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

function pickVerdict(): Verdict {
  const roll = Math.random();
  if (roll < 0.4) return "real";
  if (roll < 0.8) return "fake";
  return "uncertain";
}

function fakeScoreFor(verdict: Verdict): number {
  if (verdict === "real") return 6 + Math.random() * 20; // 6–26
  if (verdict === "fake") return 74 + Math.random() * 22; // 74–96
  return 42 + Math.random() * 16; // 42–58
}

function confidenceFor(verdict: Verdict): number {
  if (verdict === "uncertain") return 50 + Math.random() * 14;
  return 80 + Math.random() * 18;
}

function branchScoresFor(fakeScore: number): BranchScores {
  const jitter = () => (Math.random() - 0.5) * 24;
  // Mirrors the REAL v1 backend contract: only the spatial branch runs;
  // frequency and optical flow report null until v2. Faking numbers here
  // would train users to trust scores the model never produced.
  return {
    spatial: clamp(fakeScore + jitter(), 2, 98),
    frequency: null,
    opticalFlow: null,
  };
}

/**
 * Suspicious-region boxes that drift smoothly frame to frame, roughly
 * where a face would be, so scrubbing feels like real tracked detections.
 */
function buildFrames(verdict: Verdict, duration: number | null): HeatmapFrame[] {
  const boxCount = verdict === "fake" ? 2 : verdict === "uncertain" ? 1 : 0;
  const totalTime = duration && duration > 0 ? duration : FRAME_COUNT / 8;

  const anchors = Array.from({ length: boxCount }, (_, i) => ({
    cx: 0.35 + i * 0.28 + Math.random() * 0.08,
    cy: 0.35 + Math.random() * 0.15,
    w: 0.16 + Math.random() * 0.08,
    h: 0.2 + Math.random() * 0.1,
    phase: Math.random() * Math.PI * 2,
  }));

  return Array.from({ length: FRAME_COUNT }, (_, index) => {
    const t = index / (FRAME_COUNT - 1);
    const boxes: HeatmapBox[] = anchors.map((a) => {
      const driftX = Math.sin(t * Math.PI * 2.2 + a.phase) * 0.05;
      const driftY = Math.cos(t * Math.PI * 1.7 + a.phase) * 0.035;
      return {
        x: clamp(a.cx + driftX - a.w / 2, 0.02, 0.98 - a.w),
        y: clamp(a.cy + driftY - a.h / 2, 0.02, 0.98 - a.h),
        w: a.w,
        h: a.h,
        intensity: clamp(
          0.55 + Math.sin(t * Math.PI * 3 + a.phase) * 0.25 + (Math.random() - 0.5) * 0.1,
          0.2,
          1,
        ),
      };
    });
    return { index, time: t * totalTime * 0.98, boxes };
  });
}

/** Builds a small but valid PDF from scratch and returns an object URL for it. */
/** Forensic signals rendered as metric cards. Values orbit the fakeScore
 *  with per-signal jitter so a REAL video reads mostly "consistent" and a
 *  FAKE one reads mostly "anomalous" — same trick as the branch scores. */
const INDICATOR_DEFS: Array<{ id: string; label: string; description: string }> = [
  { id: "temporal", label: "Temporal Consistency", description: "Frame-to-frame coherence of scene and lighting." },
  { id: "motion", label: "Motion Pattern", description: "Physical plausibility of object and camera motion." },
  { id: "optical_flow", label: "Optical Flow", description: "Pixel-motion field consistency between frames." },
  { id: "spatial", label: "Spatial Artifacts", description: "Texture sliding and structurally impossible details." },
  { id: "compression", label: "Compression Noise", description: "Encoding fingerprints vs. generative smoothing." },
  { id: "texture_stability", label: "Texture Stability", description: "Surface detail persistence across frames." },
];

function statusFor(value: number): Indicator["status"] {
  if (value < 35) return "consistent";
  if (value < 65) return "suspicious";
  return "anomalous";
}

function buildIndicators(fakeScore: number): Indicator[] {
  return INDICATOR_DEFS.map((def) => {
    const value = clamp(fakeScore + (Math.random() - 0.5) * 28, 2, 98);
    return { ...def, value, status: statusFor(value) };
  });
}

function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  try {
    const bin = atob(dataUrl.slice(comma + 1));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// Pixel dimensions from a baseline JPEG's SOF marker.
function jpegSize(b: Uint8Array): { w: number; h: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1];
    if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
      return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
    }
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return null;
}

/** Builds the report PDF. Exported so restored history items can regenerate it
 *  (blob URLs don't survive a reload). Up to two report frames (GradCAM baked
 *  in) are embedded side by side. */
export function buildReportUrl(r: {
  fileName: string;
  verdict: Verdict;
  confidence: number;
  fakeScore: number;
  branchScores: BranchScores;
  indicators: Indicator[];
  analyzedAt: string;
  modelVersion: string;
  reportFrames?: ReportFrame[];
  bands?: { realBelow: number; fakeAbove: number };
}): string {
  const L = 56;
  const RT = 556;
  const W = RT - L;
  // Fold to ASCII so the UTF-8 byte count matches every /Length.
  const ascii = (s: string) =>
    s
      .replace(/[—–·]/g, "-")
      .replace(/…/g, "...")
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/[^\x20-\x7e]/g, "");
  const esc = (s: string) => ascii(s).replace(/[()\\]/g, (c) => `\\${c}`);
  const ops: string[] = [];
  const fill = (c: string) => ops.push(`${c} rg`);
  const strokeC = (c: string) => ops.push(`${c} RG`);
  const box = (x: number, y: number, w: number, h: number) => ops.push(`${x} ${y} ${w} ${h} re f`);
  const rule = (y: number) => ops.push(`0.5 w ${L} ${y} m ${RT} ${y} l S`);
  const t = (x: number, y: number, size: number, s: string, bold = false) =>
    ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${x} ${y} Td (${esc(s)}) Tj ET`);
  const wOf = (s: string, size: number, bold = false) => s.length * size * (bold ? 0.55 : 0.5);
  const tR = (xr: number, y: number, size: number, s: string, bold = false) =>
    t(xr - wOf(s, size, bold), y, size, s, bold);
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 3) + "..." : s);

  const INK = "0.09 0.13 0.20";
  const MUT = "0.42 0.47 0.55";
  const LINE = "0.86 0.89 0.93";
  const TRACK = "0.91 0.93 0.96";
  // bar fill by zone, matching the results page (green real / amber uncertain / red AI)
  const ZONE = { real: "0.10 0.60 0.38", uncertain: "0.80 0.55 0.05", fake: "0.83 0.20 0.24" };
  const V = {
    real: { c: "0.07 0.47 0.29", bg: "0.91 0.97 0.94", label: "REAL" },
    fake: { c: "0.80 0.18 0.26", bg: "0.99 0.93 0.94", label: "AI GENERATED" },
    uncertain: { c: "0.63 0.42 0.02", bg: "0.99 0.96 0.87", label: "UNCERTAIN" },
  }[r.verdict];
  const when = new Date(r.analyzedAt).toLocaleString();

  // header
  fill(INK); t(L, 748, 13, "ECNet", true);
  fill(MUT); tR(RT, 749, 8.5, "AI VIDEO DETECTION", true);
  strokeC(LINE); rule(740);

  // title
  fill(INK); t(L, 704, 22, "Detection Report", true);
  fill(MUT); t(L, 685, 11, clip(r.fileName, 66));

  // verdict banner
  const by = 600, bh = 64;
  fill(V.bg); box(L, by, W, bh);
  fill(V.c); box(L, by, 4, bh);
  fill(MUT); t(L + 20, by + bh - 20, 8.5, "VERDICT", true);
  fill(V.c); t(L + 20, by + 15, 21, V.label, true);
  fill(MUT); tR(RT - 20, by + bh - 20, 8.5, "AI-GENERATION SCORE", true);
  fill(INK); tR(RT - 20, by + 15, 21, `${r.fakeScore.toFixed(0)} / 100`, true);

  // summary
  let y = 548;
  fill(MUT); t(L, y, 9, "SUMMARY", true); y -= 22;
  for (const [k, v] of [
    ["Confidence", `${r.confidence.toFixed(1)}%`],
    ["Model", clip(cleanModelVersion(r.modelVersion), 52)],
    ["Analyzed", when],
  ] as Array<[string, string]>) {
    fill(MUT); t(L, y, 10.5, k);
    fill(INK); t(L + 130, y, 10.5, v);
    y -= 21;
  }

  // branch scores as bars, colored by zone (Motion hidden, like the results page)
  const realBelow = r.bands?.realBelow ?? 35;
  const fakeAbove = r.bands?.fakeAbove ?? 65;
  const zoneColor = (v: number) => ZONE[v < realBelow ? "real" : v <= fakeAbove ? "uncertain" : "fake"];
  y -= 16;
  fill(MUT); t(L, y, 9, "BRANCH SCORES", true); y -= 24;
  const barX = L + 170, barW = RT - (L + 170) - 42;
  for (const [label, val] of [
    ["Spatial (EfficientNet)", r.branchScores.spatial],
    ["Temporal (ConvLSTM)", r.branchScores.opticalFlow],
    ["Frequency (FFT)", r.branchScores.frequency],
  ] as Array<[string, number | null]>) {
    if (val === null) continue;
    fill(INK); t(L, y, 10.5, label);
    fill(TRACK); box(barX, y - 1, barW, 7);
    fill(zoneColor(val)); box(barX, y - 1, (barW * val) / 100, 7);
    fill(INK); tR(RT, y, 10, val.toFixed(1), true);
    y -= 23;
  }

  // analyzed frames: decode up to two report stills (GradCAM baked in)
  const imgs = (r.reportFrames ?? [])
    .slice(0, 2)
    .map((f) => {
      const bytes = dataUrlToBytes(f.dataUrl);
      const d = bytes ? jpegSize(bytes) : null;
      return bytes && d && d.w > 0 && d.h > 0 ? { bytes, w: d.w, h: d.h, caption: f.caption } : null;
    })
    .filter((x): x is { bytes: Uint8Array; w: number; h: number; caption: string } => x !== null);

  if (imgs.length) {
    const gap = 16;
    const slotW = imgs.length === 2 ? (W - gap) / 2 : 300;
    const maxH = imgs.length === 2 ? 150 : 172;
    const topY = 316;
    const capY = topY - maxH - 12;
    fill(MUT); t(L, 330, 9, imgs[0].caption.startsWith("Frame") ? "SAMPLED FRAMES" : "FLAGGED FRAMES", true);
    imgs.forEach((im, i) => {
      let dw = slotW;
      let dh = (dw * im.h) / im.w;
      if (dh > maxH) {
        dh = maxH;
        dw = (dh * im.w) / im.h;
      }
      const slotX = L + i * (slotW + gap);
      const ix = slotX + (slotW - dw) / 2;
      const iy = topY - dh;
      ops.push(`q ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${ix.toFixed(2)} ${iy.toFixed(2)} cm /Im${i} Do Q`);
      strokeC(LINE); ops.push(`0.8 w ${ix.toFixed(2)} ${iy.toFixed(2)} ${dw.toFixed(2)} ${dh.toFixed(2)} re S`);
      fill(MUT); t(slotX, capY, 8, im.caption);
    });
  }

  // footer
  strokeC(LINE); rule(66);
  fill(MUT);
  t(L, 52, 8.5, "Generated by ECNet - AI Video Detection");
  tR(RT, 52, 8.5, when);

  const content = ops.join("\n");
  const xobjs = imgs.map((_, i) => `/Im${i} ${7 + i} 0 R`).join(" ");
  const pageRes = imgs.length
    ? `<< /Font << /F1 4 0 R /F2 5 0 R >> /XObject << ${xobjs} >> >>`
    : "<< /Font << /F1 4 0 R /F2 5 0 R >> >>";
  const textObjs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${pageRes} /Contents 6 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];

  // Assemble as bytes so raw JPEG data survives (a UTF-8 string Blob corrupts it).
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  let pos = 0;
  const add = (p: string | Uint8Array) => {
    const b = typeof p === "string" ? encoder.encode(p) : p;
    parts.push(b);
    pos += b.length;
  };

  const offsets: number[] = [];
  add("%PDF-1.4\n");
  textObjs.forEach((body, i) => {
    offsets[i] = pos;
    add(`${i + 1} 0 obj\n${body}\nendobj\n`);
  });
  imgs.forEach((im, i) => {
    offsets[6 + i] = pos;
    add(`${7 + i} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`);
    add(im.bytes);
    add("\nendstream\nendobj\n");
  });
  const count = 6 + imgs.length;
  const xrefStart = pos;
  add(`xref\n0 ${count + 1}\n0000000000 65535 f \n`);
  for (let i = 0; i < count; i++) add(`${offsets[i].toString().padStart(10, "0")} 00000 n \n`);
  add(`trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

  const buf = new Uint8Array(pos);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return URL.createObjectURL(new Blob([buf], { type: "application/pdf" }));
}

export function generateMockResult(
  fileName: string,
  duration: number | null,
  processingMs: number,
): AnalysisResult {
  const verdict = pickVerdict();
  const fakeScore = fakeScoreFor(verdict);
  const confidence = confidenceFor(verdict);
  const branchScores = branchScoresFor(fakeScore);
  const indicators = buildIndicators(fakeScore);
  const analyzedAt = new Date().toISOString();

  return {
    fileName,
    verdict,
    confidence,
    fakeScore,
    branchScores,
    indicators,
    frames: buildFrames(verdict, duration),
    analyzedAt,
    processingMs,
    modelVersion: MODEL_VERSION,
    reportUrl: buildReportUrl({
      fileName,
      verdict,
      confidence,
      fakeScore,
      branchScores,
      indicators,
      analyzedAt,
      modelVersion: MODEL_VERSION,
    }),
  };
}
