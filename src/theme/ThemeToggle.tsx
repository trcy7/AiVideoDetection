import { useTheme } from "./ThemeContext";
import "./ThemeToggle.css";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";
  const label = `Switch to ${isDark ? "light" : "dark"} mode`;

  return (
    <button
      type="button"
      className="theme-toggle"
      data-checked={isDark}
      onClick={toggleTheme}
      aria-label={label}
      title={label}
    >
      <svg className="theme-toggle__sun" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="4.2" />
        <line x1="12" y1="2.5" x2="12" y2="5" />
        <line x1="12" y1="19" x2="12" y2="21.5" />
        <line x1="2.5" y1="12" x2="5" y2="12" />
        <line x1="19" y1="12" x2="21.5" y2="12" />
        <line x1="5.2" y1="5.2" x2="7" y2="7" />
        <line x1="17" y1="17" x2="18.8" y2="18.8" />
        <line x1="5.2" y1="18.8" x2="7" y2="17" />
        <line x1="17" y1="7" x2="18.8" y2="5.2" />
      </svg>
      <svg className="theme-toggle__moon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20 14.5A8 8 0 019.5 4 7 7 0 1020 14.5z" />
      </svg>
    </button>
  );
}
