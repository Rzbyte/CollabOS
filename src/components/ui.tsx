/**
 * Shared presentational primitives.
 *
 * Server-component friendly (no client hooks). Kept small on purpose — CLAUDE.md §14
 * asks for a narrow, purposeful interface rather than a component library.
 */
import type { ReactNode } from "react";

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-edge bg-surface-raised/60 backdrop-blur-sm ${className}`}
    >
      {(title ?? actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-edge px-5 py-3.5">
          <div>
            {title && (
              <h2 className="text-sm font-semibold tracking-wide text-ink uppercase">
                {title}
              </h2>
            )}
            {subtitle && <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

type Tone =
  | "neutral"
  | "accent"
  | "proposed"
  | "approved"
  | "attempted"
  | "succeeded"
  | "failed"
  | "test";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-edge-strong text-ink-muted",
  accent: "border-accent/45 text-accent",
  proposed: "border-proposed/45 text-proposed",
  approved: "border-approved/45 text-approved",
  attempted: "border-attempted/45 text-attempted",
  succeeded: "border-succeeded/45 text-succeeded",
  failed: "border-failed/50 text-failed",
  test: "border-test/45 text-test",
};

export function Badge({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${TONE_CLASS[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/**
 * Explicit, repeated labelling of the local test transport.
 *
 * §14 forbids presenting a mocked action as a real external action, and §17 requires
 * the transport be clearly labelled. Centralising it here means the label cannot be
 * forgotten at one call site.
 */
export function TestTransportBadge({ transport }: { transport?: string | null }) {
  return (
    <Badge tone="test">
      <span aria-hidden="true">◆</span>
      Local test transport{transport ? ` · ${transport}` : ""}
    </Badge>
  );
}

export function StatusDot({ tone }: { tone: Tone }) {
  const bg: Record<Tone, string> = {
    neutral: "bg-ink-faint",
    accent: "bg-accent",
    proposed: "bg-proposed",
    approved: "bg-approved",
    attempted: "bg-attempted",
    succeeded: "bg-succeeded",
    failed: "bg-failed",
    test: "bg-test",
  };
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-2 shrink-0 rounded-full ${bg[tone]}`}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium tracking-wide text-ink-faint uppercase">
        {label}
      </dt>
      <dd className="mt-1 text-sm text-ink">{children}</dd>
    </div>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-edge-strong px-5 py-8 text-center">
      <p className="text-sm font-medium text-ink-muted">{title}</p>
      {children && <div className="mt-2 text-sm text-ink-faint">{children}</div>}
    </div>
  );
}
