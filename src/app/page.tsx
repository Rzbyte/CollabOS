/**
 * A. Command Center (CLAUDE.md §14A).
 *
 * Shows the creator objective, the active campaign and its state, pending approvals, the
 * next autonomous action, cognition balance, and recent agent actions with proposed /
 * approved / attempted / succeeded / failed visually distinguished.
 *
 * The Mind panel is deliberately blunt when credentials are absent: no capability is
 * implied that has not been proven.
 */
import Link from "next/link";

import { describeEnv, loadEnv } from "../env.ts";
import {
  Badge,
  EmptyState,
  Field,
  Panel,
  StatusDot,
  TestTransportBadge,
} from "../components/ui.tsx";
import { CancelCampaignForm, ObjectiveForm, RetryRecommendationsForm } from "../components/forms.tsx";
import { Footnote, Header } from "../components/nav.tsx";
import {
  getActivityLog,
  getCreator,
  getCurrentCampaign,
  getPendingApprovals,
} from "../lib/campaign/queries.ts";
import { CampaignStatus, HAPPY_PATH, STATUS_LABELS, isTerminal } from "../lib/campaign/states.ts";
import { getMindsPort } from "../lib/minds/client.ts";
import { toCollabOsMindsError } from "../lib/minds/errors.ts";
import { PHASE_TONE, phaseLabel } from "./phase-style.ts";

export const dynamic = "force-dynamic";

/**
 * Reads the live cognition balance, degrading honestly.
 *
 * Never throws into the render: an unreachable Mind shows as "unavailable" with the
 * reason, not as a crashed page or a fabricated number.
 */
async function readCognition(): Promise<{ value: number | null; error: string | null }> {
  const port = getMindsPort();
  if (!port.isConfigured()) return { value: null, error: "Mind not connected" };

  try {
    return { value: await port.getCognitionBalance(), error: null };
  } catch (error) {
    return { value: null, error: toCollabOsMindsError(error).message };
  }
}

export default async function CommandCenterPage() {
  const env = loadEnv();
  const status = describeEnv();

  const [creator, campaign, cognition] = await Promise.all([
    getCreator(),
    getCurrentCampaign(),
    readCognition(),
  ]);

  const [approvals, timeline] = await Promise.all([
    campaign ? getPendingApprovals(campaign.id) : Promise.resolve([]),
    getActivityLog({ limit: 40 }),
  ]);

  const recentEvents = timeline.slice(-8).reverse();
  const campaignActive = campaign && !isTerminal(campaign.status);

  return (
    <main id="main" className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
      <Header current="command" />

      <div className="grid gap-5 lg:grid-cols-3">
        {/* ------------------------------------------------- active campaign */}
        <Panel
          title={campaignActive ? "Active campaign" : "Start a campaign"}
          subtitle={
            campaignActive
              ? undefined
              : "Submit one growth objective — CollabOS handles the rest between approval points."
          }
          className="lg:col-span-2"
          actions={
            campaign && campaignActive ? (
              <Badge tone="accent">{STATUS_LABELS[campaign.status]}</Badge>
            ) : undefined
          }
        >
          {campaign && campaignActive ? (
            <div className="space-y-5">
              <Field label="Growth objective">{campaign.objective}</Field>

              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Current state">
                  <code className="font-mono text-xs">{campaign.status}</code>
                </Field>
                <Field label="Approved partner">
                  {campaign.approvedPartner?.name ?? (
                    <span className="text-ink-faint">Not yet chosen</span>
                  )}
                </Field>
                <Field label="Follow-ups sent">
                  {campaign.followUpCount}
                  <span className="text-ink-faint"> / 1 max</span>
                </Field>
              </div>

              {/* Progress rail */}
              <div>
                <p className="text-xs font-medium tracking-wide text-ink-faint uppercase">
                  Progress
                </p>
                <ol className="mt-2 flex flex-wrap gap-1.5">
                  {HAPPY_PATH.map((step) => {
                    const reached =
                      HAPPY_PATH.indexOf(step) <= HAPPY_PATH.indexOf(campaign.status);
                    const current = step === campaign.status;
                    return (
                      <li
                        key={step}
                        className={`rounded px-2 py-1 text-xs ${
                          current
                            ? "bg-accent text-accent-ink font-medium"
                            : reached
                              ? "bg-succeeded/15 text-succeeded"
                              : "bg-surface-inset text-ink-faint"
                        }`}
                      >
                        {STATUS_LABELS[step]}
                      </li>
                    );
                  })}
                </ol>
              </div>

              <div className="flex flex-wrap items-start gap-3 border-t border-edge pt-4">
                {campaign.status === CampaignStatus.partners_recommended && (
                  <Link
                    href="/partners"
                    className="rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-accent-ink transition hover:brightness-110"
                  >
                    Review candidates
                  </Link>
                )}
                {campaign.status === CampaignStatus.objective_submitted && (
                  <RetryRecommendationsForm campaignId={campaign.id} />
                )}
                <CancelCampaignForm campaignId={campaign.id} />
              </div>
            </div>
          ) : creator ? (
            <ObjectiveForm />
          ) : (
            <EmptyState title="No creator profile seeded">
              Run <code className="font-mono text-xs">npm run db:seed</code> to load the
              demo scenario.
            </EmptyState>
          )}
        </Panel>

        {/* -------------------------------------------------- platform status */}
        <Panel title="Platform status">
          <ul className="space-y-3">
            <li className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm">
                <StatusDot tone={status.mindsConfigured ? "succeeded" : "failed"} />
                Minds connection
              </span>
              <Badge tone={status.mindsConfigured ? "succeeded" : "failed"}>
                {status.mindsConfigured ? "Configured" : "Not connected"}
              </Badge>
            </li>
            <li className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm">
                <StatusDot tone={cognition.value !== null ? "succeeded" : "attempted"} />
                Cognition balance
              </span>
              {cognition.value !== null ? (
                <Badge tone="succeeded">{cognition.value.toLocaleString("en-US")}</Badge>
              ) : (
                <Badge tone="attempted">Unavailable</Badge>
              )}
            </li>
            <li className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm">
                <StatusDot tone="succeeded" />
                PostgreSQL
              </span>
              <Badge tone="succeeded">Connected</Badge>
            </li>
            <li className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm">
                <StatusDot tone="test" />
                Outbound email
              </span>
              <TestTransportBadge transport={env.EMAIL_TRANSPORT} />
            </li>
          </ul>

          {cognition.error && !status.mindsConfigured && (
            <p className="mt-4 rounded-md border border-failed/35 bg-failed/5 px-3 py-2.5 text-xs text-failed">
              The Mind is not connected, so no partner reasoning can run. CollabOS will
              not fabricate a recommendation to cover this. Missing:{" "}
              <code className="font-mono">{status.missing.join(", ")}</code>. See{" "}
              <code className="font-mono">docs/minds-smoke-test.md</code>.
            </p>
          )}
          {cognition.error && status.mindsConfigured && (
            <p className="mt-4 rounded-md border border-attempted/35 bg-attempted/5 px-3 py-2.5 text-xs text-attempted">
              {cognition.error}
            </p>
          )}
        </Panel>

        {/* ---------------------------------------------- pending approvals */}
        <Panel
          title="Pending your approval"
          subtitle="CollabOS will not proceed past these without you"
        >
          {approvals.length ? (
            <ul className="space-y-3">
              {approvals.map((approval) => {
                const payload = approval.payload as { partnerName?: string } | null;
                return (
                  <li
                    key={approval.id}
                    className="rounded-lg border border-attempted/40 bg-attempted/5 px-3.5 py-3"
                  >
                    <p className="text-sm font-medium text-attempted">
                      {approval.actionType.replace(/_/g, " ")}
                    </p>
                    {payload?.partnerName && (
                      <p className="mt-1 text-sm text-ink-muted">{payload.partnerName}</p>
                    )}
                    <p className="mt-1 text-xs text-ink-faint">
                      Requested {approval.requestedAt.toISOString().slice(0, 16).replace("T", " ")}
                    </p>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-ink-faint">Nothing awaiting your decision.</p>
          )}
        </Panel>

        {/* ------------------------------------------------ next autonomous */}
        <Panel title="Next autonomous action">
          {campaign?.nextActionAt ? (
            <dl className="space-y-4">
              <Field label="Scheduled for">
                <code className="font-mono text-xs">
                  {campaign.nextActionAt.toISOString().replace("T", " ").slice(0, 19)}Z
                </code>
              </Field>
              <Field label="Trigger">
                <span className="text-ink-muted">
                  Server-side worker polling{" "}
                  <code className="font-mono text-xs">nextActionAt</code>
                </span>
              </Field>
            </dl>
          ) : (
            <dl className="space-y-4">
              <Field label="Scheduled">
                <span className="text-ink-faint">Nothing scheduled</span>
              </Field>
              <Field label="Deliverable window">
                {env.FOLLOW_UP_DELAY_SECONDS}s (
                {Math.round(env.FOLLOW_UP_DELAY_SECONDS / 60)} min)
              </Field>
            </dl>
          )}
          <p className="mt-4 border-t border-edge pt-3 text-xs text-ink-faint">
            There is no manual “Follow Up” button anywhere in CollabOS. Autonomy is proven
            by a separate worker process, not a button.
          </p>
        </Panel>

        {/* --------------------------------------------------- recent actions */}
        <Panel
          title="Latest agent actions"
          subtitle="Each execution phase is recorded separately"
          className="lg:col-span-3"
          actions={
            <Link
              href="/activity"
              className="text-sm text-accent underline-offset-4 hover:underline"
            >
              Full activity log →
            </Link>
          }
        >
          {recentEvents.length ? (
            <ul className="divide-y divide-edge">
              {recentEvents.map((event, index) => (
                <li
                  key={`${event.actionId}-${event.phase}-${index}`}
                  className="flex flex-wrap items-start gap-x-3 gap-y-1.5 py-2.5"
                >
                  <code className="font-mono text-xs text-ink-faint">
                    {event.at.toISOString().slice(11, 19)}
                  </code>
                  <Badge tone={PHASE_TONE[event.phase]}>{phaseLabel(event.phase)}</Badge>
                  <span className="min-w-0 flex-1 text-sm text-ink">
                    {event.summary.replace(/^[A-Za-z]+ — /, "")}
                  </span>
                  {event.autonomous && <Badge tone="accent">Autonomous</Badge>}
                  {event.transport && <TestTransportBadge transport={event.transport} />}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No agent actions yet">
              Submit a growth objective to begin.
            </EmptyState>
          )}
        </Panel>

        {/* -------------------------------------------------- brand memory */}
        <Panel
          title="Creator brand memory"
          subtitle="Persisted in PostgreSQL and sent to the Mind as structured context"
          className="lg:col-span-3"
        >
          {creator ? (
            <>
              <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Creator">{creator.name}</Field>
                <Field label="Niche">{creator.niche}</Field>
                <Field label="Target audience">{creator.targetAudience}</Field>
                <Field label="Brand voice">{creator.brandVoice}</Field>
              </dl>

              <div className="mt-5 border-t border-edge pt-4">
                <p className="text-xs font-medium tracking-wide text-ink-faint uppercase">
                  Prohibited partnerships — hard boundary
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {creator.prohibitedTopics.map((topic) => (
                    <Badge key={topic} tone="failed">
                      {topic}
                    </Badge>
                  ))}
                </div>
              </div>

              <div className="mt-5 border-t border-edge pt-4">
                <p className="text-xs font-medium tracking-wide text-ink-faint uppercase">
                  Relationship history
                </p>
                {creator.relationships.length ? (
                  <ul className="mt-2.5 space-y-2">
                    {creator.relationships.map((rel) => (
                      <li
                        key={rel.id}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
                      >
                        <span className="font-medium">{rel.partner.name}</span>
                        <Badge tone={rel.status === "collaborated" ? "succeeded" : "attempted"}>
                          {rel.status}
                        </Badge>
                        <span className="text-ink-muted">
                          {rel.collaborationCount} collaboration
                          {rel.collaborationCount === 1 ? "" : "s"}
                        </span>
                        {rel.rejectionReason && (
                          <span className="text-ink-faint">— {rel.rejectionReason}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-ink-faint">No history recorded yet.</p>
                )}
              </div>
            </>
          ) : (
            <EmptyState title="No creator profile seeded">
              Run <code className="font-mono text-xs">npm run db:seed</code>.
            </EmptyState>
          )}
        </Panel>
      </div>

      <Footnote />
    </main>
  );
}
