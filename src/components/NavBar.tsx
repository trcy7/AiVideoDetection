import { useEffect, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import "./NavBar.css";

const NAV_LINKS = [
  { to: "/#analyze", label: "Analyze" },
  { to: "/#technology", label: "Technology" },
  { to: "/#features", label: "Features" },
  { to: "/#faq", label: "FAQ" },
];

export function NavBar() {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const onChange = () => setMenuOpen(false);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return (
    <header className="navbar">
      <div className="navbar__inner container">
        <Link className="navbar__brand" to="/" onClick={() => setMenuOpen(false)}>
          <span className="navbar__brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" className="navbar__brand-glyph">
              <rect x="5.4" y="5.4" width="2.7" height="13.2" rx="1.35" />
              <rect x="5.4" y="5.4" width="12.6" height="2.7" rx="1.35" />
              <rect x="5.4" y="10.65" width="8.6" height="2.7" rx="1.35" />
              <rect x="5.4" y="15.9" width="12.6" height="2.7" rx="1.35" />
            </svg>
          </span>
          <span className="navbar__brand-name">ECNet</span>
        </Link>

        <nav className="navbar__links" aria-label="Main navigation">
          {NAV_LINKS.map((link) => (
            <Link key={link.to} className="navbar__link" to={link.to}>
              {link.label}
            </Link>
          ))}
          <NavLink
            to="/results"
            className={({ isActive }) =>
              `navbar__link${isActive ? " navbar__link--active" : ""}`
            }
          >
            Results
          </NavLink>
        </nav>

        <div className="navbar__actions">
          <button
            type="button"
            className="navbar__burger"
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="navbar__burger-bar" aria-hidden="true" />
            <span className="navbar__burger-bar" aria-hidden="true" />
            <span className="navbar__burger-bar" aria-hidden="true" />
          </button>
        </div>
      </div>

      {menuOpen && (
        <nav id="mobile-menu" className="navbar__mobile" aria-label="Mobile navigation">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.to}
              className="navbar__mobile-link"
              to={link.to}
              onClick={() => setMenuOpen(false)}
            >
              {link.label}
            </Link>
          ))}
          <Link className="navbar__mobile-link" to="/results" onClick={() => setMenuOpen(false)}>
            Results
          </Link>
        </nav>
      )}
    </header>
  );
}
