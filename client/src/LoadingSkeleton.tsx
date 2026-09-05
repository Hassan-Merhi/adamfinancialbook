export default function LoadingSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`loading-shell${compact ? ' compact' : ''}`} role="status" aria-live="polite" aria-label="Loading financial book">
      <span className="sr-only">Loading financial book…</span>
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-prompt" />
      <div className="skeleton-grid">
        <div className="skeleton skeleton-tile" />
        <div className="skeleton skeleton-tile" />
      </div>
      {!compact && (
        <>
          <div className="skeleton skeleton-card" />
          <div className="skeleton skeleton-card short" />
        </>
      )}
    </div>
  );
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="loading-rows" role="status" aria-live="polite" aria-label="Loading">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }, (_, index) => (
        <div className="loading-row" key={index}>
          <span className="skeleton skeleton-line" />
          <span className="skeleton skeleton-value" />
        </div>
      ))}
    </div>
  );
}
