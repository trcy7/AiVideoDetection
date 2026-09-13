import { Link } from "react-router-dom";
import "./Footer.css";

const LINK_GROUPS = [
  {
    title: "Product",
    links: [
      { label: "Analyze a video", href: "/#analyze" },
      { label: "Results", href: "/results" },
      { label: "Technology", href: "/#technology" },
      { label: "FAQ", href: "/#faq" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="footer">
      <div className="container footer__inner">
        <div className="footer__about">
          <div className="footer__brand">
            <span className="footer__brand-mark" aria-hidden="true" />
            ECNet
          </div>
          <p className="footer__blurb">
            ECNet is a research project exploring explainable detection of
            AI-generated video. It analyzes whole frames for the traces
            generators leave behind — and shows its evidence instead of asking
            for blind trust.
          </p>
        </div>

        <div className="footer__links">
          {LINK_GROUPS.map((group) => (
            <nav
              key={group.title}
              className="footer__group"
              aria-label={group.title}
            >
              <span className="footer__group-title">{group.title}</span>
              {group.links.map((link) =>
                link.href.startsWith("/") ? (
                  <Link
                    key={link.label}
                    className="footer__link"
                    to={link.href}
                  >
                    {link.label}
                  </Link>
                ) : (
                  <a key={link.label} className="footer__link" href={link.href}>
                    {link.label}
                  </a>
                ),
              )}
            </nav>
          ))}
        </div>
      </div>

      <div className="container footer__bottom">
        <span>
          © {new Date().getFullYear()} ECNet. Research preview — results are
          illustrative.
        </span>
      </div>
    </footer>
  );
}
