import "./SectionDivider.css";

/** Slim decorative divider between major sections. Purely visual. */
export function SectionDivider() {
  return (
    <div className="divider" aria-hidden="true">
      <span className="divider__line" />
      <span className="divider__dot" />
      <span className="divider__line divider__line--right" />
    </div>
  );
}
