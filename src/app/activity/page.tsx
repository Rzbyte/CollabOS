/**
 * D. Agent Activity Log (CLAUDE.md §14D).
 *
 * Chronological proof of execution. Because `toTimelineEvents` emits one entry per
 * recorded lifecycle timestamp, a single action appears as several lines — which is what
 * makes "attempted" verifiably distinct from "succeeded".
 *
 * Test transports are labelled on every row that used one. A failed action shows its
 * sanitised error and never renders as a success.
 */
import { Badge, EmptyState, Panel, TestTransportBadge } from "../../components/ui.tsx";
import { Footnote, Header } from "../../components/nav.tsx";
import { getActivityLog, getCurrentCampaign, getMindExchanges } from "../../lib/campaign/queries.ts";
import { PHASE_TONE, phaseLabel } from "../phase-style.ts";

export const dynamic = "force-dynamic";

export default async function ActivityLogPage() {
  const campaign = await getCurrentCampaign();
  const [timeline, exchanges] = await Promise.all([
    getActivityLog({ limit: 300 }),
    campaign ? getMindExchanges(campaign.id) : Promise.resolve([]),
  ]);

  const ordered = [...timeline].reverse(); // newest first for reading
  const counts = {
    proposed: timeline.filter((e) => e.phase === "proposed").length,
    approved: timeline.filter((e) => e.phase === "approved").length,
    attempted: timeline.filter((e) => e.phase === "attempted").length,
    succeeded: timeline.filter((e) => e.phase === "succeeded").length,
    failed: timeline.filter((e) => e.phase === "failed").length,
  };

  return (
    <main id="main" className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
      <Header current="activity" />

      <div className="space-y-5">
        <Panel
          title="Execution phases"
          subtitle="Every action records each phase it reached, separately"
        >
          <ul className="flex flex-wrap gap-2.5">
            {(
              [
                ["proposed", counts.proposed],
                ["approved", counts.approved],
                ["attempted", counts.attempted],
                ["succeeded", counts.succeeded],
                ["failed", counts.failed],
              ] as const
            ).map(([phase, count]) => (
              <li key={phase}>
                <Badge tone={PHASE_TONE[phase]}>
                  {phaseLabel(phase)}: {count}
                </Badge>
              </li>
            ))}
          </ul>
          <p className="mt-3.5 text-xs text-ink-faint">
            An action that was tried and failed keeps its “Attempted” entry permanently
            and never gains a “Succeeded” entry. Attempted and succeeded counts differing
            is therefore meaningful, not a bug.
          </p>
        </Panel>

        <Panel title="Activity log" subtitle="Newest first">
          {ordered.length ? (
            <ol className="divide-y divide-edge">
              {ordered.map((event, index) => (
                <li
                  key={`${event.actionId}-${event.phase}-${index}`}
                  className="py-3"
                >
                  <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
                    <code className="font-mono text-xs text-ink-faint">
                      {event.at.toISOString().replace("T", " ").slice(0, 19)}
                    </code>
                    <Badge tone={PHASE_TONE[event.phase]}>{phaseLabel(event.phase)}</Badge>
                    <span className="min-w-0 flex-1 text-sm text-ink">
                      {event.summary.replace(/^[A-Za-z]+ — /, "")}
                    </span>
                    {event.autonomous && <Badge tone="accent">Autonomous</Badge>}
                    {event.requiresApproval && <Badge tone="approved">Human gate</Badge>}
                    {event.transport && <TestTransportBadge transport={event.transport} />}
                  </div>

                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-1">
                    <code className="font-mono text-[11px] text-ink-faint">
                      {event.actionType}
                    </code>
                    <span className="font-mono text-[11px] text-ink-faint opacity-60">
                      corr {event.correlationId.slice(0, 8)}
                    </span>
                  </div>

                  {event.phase === "failed" && event.sanitisedErrorMessage && (
                    <p className="mt-2 rounded-md border border-failed/35 bg-failed/5 px-3 py-2 text-xs text-failed">
                      <span className="font-mono">{event.errorCode}</span> —{" "}
                      {event.sanitisedErrorMessage}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState title="No activity recorded yet">
              Submit a growth objective from the Command Center.
            </EmptyState>
          )}
        </Panel>

        {/* Verifiability: exactly what was asked of the Mind, and what came back. */}
        <Panel
          title="Mind exchanges"
          subtitle="Raw prompts and replies for this campaign — verifiable, not summarised"
        >
          {exchanges.length ? (
            <ul className="space-y-3">
              {exchanges.map((exchange) => (
                <li key={exchange.id} className="rounded-lg border border-edge bg-surface-inset/40">
                  <div className="flex flex-wrap items-center gap-2.5 border-b border-edge px-3.5 py-2.5">
                    <Badge tone="accent">{exchange.purpose.replace(/_/g, " ")}</Badge>
                    <Badge tone={exchange.validated ? "succeeded" : "failed"}>
                      {exchange.validated ? "Schema valid" : "Schema invalid"}
                    </Badge>
                    {/* Persisted per row, so a canned reply stays identifiable forever. */}
                    {exchange.fixtureMode && (
                      <Badge tone="failed">⚠ FIXTURE — not a real Mind</Badge>
                    )}
                    {exchange.latencyMs !== null && (
                      <span className="font-mono text-xs text-ink-faint">
                        {exchange.latencyMs}ms
                      </span>
                    )}
                    <span className="font-mono text-xs text-ink-faint">
                      alias {exchange.alias}
                    </span>
                  </div>
                  <details className="px-3.5 py-2.5">
                    <summary className="cursor-pointer text-sm text-ink-muted">
                      View prompt and reply
                    </summary>
                    <div className="mt-3 space-y-3">
                      <div>
                        <p className="text-xs font-medium tracking-wide text-ink-faint uppercase">
                          Prompt sent
                        </p>
                        <pre className="mt-1.5 max-h-72 overflow-auto rounded bg-surface-inset px-3 py-2 font-mono text-[11px] whitespace-pre-wrap text-ink-muted">
                          {exchange.requestText}
                        </pre>
                      </div>
                      <div>
                        <p className="text-xs font-medium tracking-wide text-ink-faint uppercase">
                          Reply received
                        </p>
                        <pre className="mt-1.5 max-h-72 overflow-auto rounded bg-surface-inset px-3 py-2 font-mono text-[11px] whitespace-pre-wrap text-ink-muted">
                          {exchange.replyText ?? "(no reply)"}
                        </pre>
                      </div>
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-faint">
              No Mind exchanges recorded for the current campaign.
            </p>
          )}
        </Panel>
      </div>

      <Footnote />
    </main>
  );
}
