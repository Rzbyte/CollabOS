/**
 * Route-level loading state.
 *
 * Every page is `force-dynamic` and reads from Postgres (and, on the Command Center and Room,
 * makes a live Minds call), so a visible skeleton matters — a blank screen during a slow
 * cognition-balance or Circle read looks like a hang.
 */
export default function Loading() {
  return (
    <main className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
      <div className="mb-8">
        <div className="h-8 w-40 animate-pulse rounded bg-surface-raised" />
        <div className="mt-3 h-4 w-80 animate-pulse rounded bg-surface-raised" />
        <div className="mt-5 h-10 w-full animate-pulse rounded bg-surface-raised" />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {[0, 1, 2, 3].map((index) => (
          <div
            key={index}
            className={`rounded-xl border border-edge bg-surface-raised/40 p-5 ${
              index === 0 ? "lg:col-span-2" : ""
            }`}
          >
            <div className="h-4 w-32 animate-pulse rounded bg-surface-raised" />
            <div className="mt-4 space-y-2.5">
              <div className="h-3 w-full animate-pulse rounded bg-surface-raised" />
              <div className="h-3 w-5/6 animate-pulse rounded bg-surface-raised" />
              <div className="h-3 w-2/3 animate-pulse rounded bg-surface-raised" />
            </div>
          </div>
        ))}
      </div>

      <p className="sr-only" role="status">
        Loading CollabOS…
      </p>
    </main>
  );
}
