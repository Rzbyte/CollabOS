"use client";

/**
 * Route-level error boundary.
 *
 * Shows the error message because CollabOS's domain errors are written to be actionable
 * ("MINDS_MIND_ID is not present on this builder account…", "DATABASE_URL must be a
 * PostgreSQL connection string…"). Hiding those behind a generic apology would waste the work
 * that went into making them useful.
 *
 * Safe to display: every message that reaches here has passed through
 * `sanitiseErrorMessage`, and no error text in this codebase interpolates a credential.
 */
import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("CollabOS render error:", error);
  }, [error]);

  return (
    <main className="mx-auto max-w-2xl px-5 py-16 sm:px-8">
      <h1 className="text-xl font-semibold">CollabOS</h1>

      <div
        role="alert"
        className="mt-6 rounded-xl border border-failed/45 bg-failed/5 px-5 py-4"
      >
        <p className="text-sm font-semibold text-failed">Something failed while rendering</p>
        <p className="mt-2 text-sm text-ink-muted">{error.message}</p>
        {error.digest && (
          <p className="mt-2 font-mono text-xs text-ink-faint">digest {error.digest}</p>
        )}
      </div>

      <div className="mt-6 space-y-3 text-sm text-ink-muted">
        <p>Common causes in a local setup:</p>
        <ul className="list-inside list-disc space-y-1.5">
          <li>
            Postgres is not running — start it with{" "}
            <code className="font-mono text-xs">npm run infra:up</code>
          </li>
          <li>
            Migrations have not been applied —{" "}
            <code className="font-mono text-xs">npm run db:migrate</code>
          </li>
          <li>
            No seed data —{" "}
            <code className="font-mono text-xs">npm run db:seed</code>
          </li>
          <li>
            <code className="font-mono text-xs">.env</code> is missing or invalid — copy{" "}
            <code className="font-mono text-xs">.env.example</code>
          </li>
        </ul>
      </div>

      <button
        type="button"
        onClick={reset}
        className="mt-6 rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-accent-ink transition hover:brightness-110"
      >
        Try again
      </button>
    </main>
  );
}
