import { useEffect, useRef, useState } from "react";
import "./StatsBand.css";

interface Stat {
  value: number;
  decimals: number;
  suffix: string;
  label: string;
  /** Render with thousands separators (e.g. 736,000) instead of a suffix. */
  group?: boolean;
}

const STATS: Stat[] = [
  { value: 736000, decimals: 0, suffix: "", label: "Frames analyzed", group: true },
  { value: 13, decimals: 0, suffix: "", label: "Generator models" },
  { value: 32, decimals: 0, suffix: "", label: "Frames per scan" },
  { value: 3, decimals: 0, suffix: "", label: "Analysis branches" },
];

const COUNT_MS = 1400;

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function StatsBand() {
  const ref = useRef<HTMLDivElement>(null);
  // progress 0→1 drives every counter from one rAF loop
  const [progress, setProgress] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const start = () => {
      if (started.current) return;
      started.current = true;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        setProgress(1);
        return;
      }
      const t0 = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - t0) / COUNT_MS);
        setProgress(easeOutCubic(t));
        if (t < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          start();
          observer.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="stats-band" ref={ref} role="list" aria-label="Detection statistics">
      {STATS.map((stat) => (
        <div key={stat.label} className="stats-band__item" role="listitem">
          <span className="stats-band__value">
            {stat.group
              ? Math.round(stat.value * progress).toLocaleString()
              : (stat.value * progress).toFixed(stat.decimals)}
            {stat.suffix}
          </span>
          <span className="hud-label">{stat.label}</span>
        </div>
      ))}
    </div>
  );
}
