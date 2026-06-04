/**
 * Suspense fallback shown while a lazily-loaded route chunk downloads.
 * Deliberately tiny and dependency-free so it lives in the entry bundle and
 * paints instantly — the heavy page code is what we are waiting on.
 */
export function RouteFallback() {
  return (
    <div
      className="flex h-full w-full items-center justify-center py-16 text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <span className="animate-pulse">Loading…</span>
    </div>
  );
}
