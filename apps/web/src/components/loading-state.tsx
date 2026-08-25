export function LoadingState(): React.JSX.Element {
  return (
    <div className="loading-page" role="status" aria-label="Loading ArcDB data">
      <span className="skeleton skeleton-title" />
      <span className="skeleton skeleton-subtitle" />
      <div className="skeleton-grid">
        <span className="skeleton skeleton-card" />
        <span className="skeleton skeleton-card" />
        <span className="skeleton skeleton-card" />
        <span className="skeleton skeleton-card" />
      </div>
      <span className="skeleton skeleton-table" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
