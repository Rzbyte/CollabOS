"use client";

/**
 * Periodic server refresh.
 *
 * The follow-up worker runs in a separate process, so the page has no way to know when it
 * acts. Polling `router.refresh()` re-renders the server components with current data,
 * which is what lets a viewer watch the autonomous follow-up appear without touching
 * anything.
 *
 * Deliberately not a websocket: the point of the demo is that the SERVER acted on its own,
 * and a dumb poll makes that easier to believe than a push channel that could be mistaken
 * for the client triggering the work.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function AutoRefresh({
  intervalMs = 5000,
  label = "Live",
}: {
  intervalMs?: number;
  label?: string;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!enabled) return;

    timer.current = setInterval(() => {
      router.refresh();
      setLastRefresh(new Date());
    }, intervalMs);

    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [enabled, intervalMs, router]);

  return (
    <button
      type="button"
      onClick={() => setEnabled((value) => !value)}
      aria-pressed={enabled}
      title={
        enabled
          ? `Refreshing every ${Math.round(intervalMs / 1000)}s. Click to pause.`
          : "Paused. Click to resume."
      }
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition ${
        enabled
          ? "border-succeeded/45 text-succeeded"
          : "border-edge-strong text-ink-faint"
      }`}
    >
      <span
        aria-hidden="true"
        className={`inline-block size-2 rounded-full ${
          enabled ? "animate-pulse bg-succeeded" : "bg-ink-faint"
        }`}
      />
      {enabled ? label : "Paused"}
      {enabled && lastRefresh && (
        <span className="font-mono opacity-60">
          {lastRefresh.toISOString().slice(14, 19)}
        </span>
      )}
    </button>
  );
}
