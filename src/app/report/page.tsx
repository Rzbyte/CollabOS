/**
 * Campaign report (CLAUDE.md §22, Milestone 6).
 *
 * The closing artefact: what was decided, what was executed, what was observed, and what
 * changed in memory as a result.
 *
 * The section that matters most for credibility is "What this report does not claim". A
 * report that quietly implied audience growth would be exactly the fabricated metric §18
 * prohibits, so the absence is stated outright rather than left for the reader to notice.
 */
import Link from "next/link";

import { Footnote, Header } from "../../components/nav.tsx";
import { Badge, EmptyState, Field, Panel, TestTransportBadge } from "../../components/ui.tsx";
import {
  getPhaseCounts,
  getRelationships,
  getReportCampaign,
} from "../../lib/campaign/queries.ts";
import { CampaignStatus, STATUS_LABELS } from "../../lib/campaign/states.ts";

export const dynamic = "force-dynamic";

export default async function CampaignReportPage() {
  const campaign = await getReportCampaign();

  if (!campaign) {
    return (
      <main id="main" className="mx-auto max-w-4xl px-5 py-10 sm:px-8">
        <Header current="report" />
        <EmptyState title="No campaign to report on">
          <Link href="/" className="text-accent underline-offset-4 hover:underline">
            Submit a growth objective
          </Link>{" "}
          to begin.
        </EmptyState>
        <Footnote />
      </main>
    );
  }

  const [phases, relationships] = await Promise.all([
    getPhaseCounts(campaign.id),
    getRelationships(campaign.creatorId),
  ]);

  const partner = campaign.approvedPartner;
  const deliverable = campaign.deliverables[0] ?? null;
  const outcome = campaign.outcome;
  const chosen = campaign.recommendations.find((r) => r.partnerId === campaign.approvedPartnerId);
  const isComplete = campaign.status === CampaignStatus.completed;

  return (
    <main id="main" className="mx-auto max-w-4xl px-5 py-10 sm:px-8">
      <Header current="report" />

      <div className="space-y-5">
        <Panel
          title="Campaign report"
          subtitle={campaign.objective}
          actions={
            <Badge tone={isComplete ? "succeeded" : "attempted"}>
              {STATUS_LABELS[campaign.status]}
            </Badge>
          }
        >
          <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Creator">{campaign.creator.name}</Field>
            <Field label="Partner">{partner?.name ?? "—"}</Field>
            <Field label="Started">
              <code className="font-mono text-xs">
                {campaign.createdAt.toISOString().slice(0, 16).replace("T", " ")}
              </code>
            </Field>
            <Field label="Autonomous follow-ups">
              {campaign.followUpCount}
              <span className="text-ink-faint"> / 1 max</span>
            </Field>
          </dl>
        </Panel>

        {/* ------------------------------------------------- the Mind's decision */}
        <Panel
          title="Why this partner"
          subtitle="The Mind's recorded reasoning, not a summary written after the fact"
        >
          {chosen ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium">{chosen.partner.name}</span>
                <Badge tone="succeeded">rank {chosen.rank}</Badge>
                <Badge tone="accent">fit {Math.round(chosen.fitScore)}</Badge>
                <span className="font-mono text-xs text-ink-faint">
                  audience {chosen.partner.audienceSize.toLocaleString("en-US")}
                </span>
              </div>

              <div className="mt-4 grid gap-5 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-medium tracking-wide text-ink-faint uppercase">
                    Reasons
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {chosen.reasons.map((reason, i) => (
                      <li key={i} className="text-sm text-ink">
                        + {reason}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="text-xs font-medium tracking-wide text-ink-faint uppercase">
                    Memory used
                  </p>
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {chosen.memoryUsed.length ? (
                      chosen.memoryUsed.map((memory, i) => (
                        <li
                          key={i}
                          className="rounded-md border border-accent/35 bg-accent/8 px-2.5 py-1 text-xs text-accent"
                        >
                          {memory}
                        </li>
                      ))
                    ) : (
                      <li className="text-sm text-ink-faint">None recorded.</li>
                    )}
                  </ul>
                </div>
              </div>

              {/* Shows the decision was not follower-count driven. */}
              <div className="mt-5 border-t border-edge pt-4">
                <p className="text-xs font-medium tracking-wide text-ink-faint uppercase">
                  Candidates not chosen
                </p>
                <ul className="mt-2 space-y-1.5">
                  {campaign.recommendations
                    .filter((r) => r.partnerId !== campaign.approvedPartnerId)
                    .map((r) => (
                      <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="text-ink">{r.partner.name}</span>
                        <Badge tone={r.recommendation === "reject" ? "failed" : "attempted"}>
                          {r.recommendation}
                        </Badge>
                        <span className="font-mono text-xs text-ink-faint">
                          fit {Math.round(r.fitScore)} · audience{" "}
                          {r.partner.audienceSize.toLocaleString("en-US")}
                        </span>
                      </li>
                    ))}
                </ul>
              </div>
            </>
          ) : (
            <p className="text-sm text-ink-faint">No partner recommendation recorded.</p>
          )}
        </Panel>

        {/* ------------------------------------------------------ what happened */}
        <Panel title="Execution summary" subtitle="Counted from the audit log">
          <ul className="flex flex-wrap gap-2.5">
            <li>
              <Badge tone="proposed">Proposed: {phases.proposed}</Badge>
            </li>
            <li>
              <Badge tone="approved">Approved: {phases.approved}</Badge>
            </li>
            <li>
              <Badge tone="attempted">Attempted: {phases.attempted}</Badge>
            </li>
            <li>
              <Badge tone="succeeded">Succeeded: {phases.succeeded}</Badge>
            </li>
            <li>
              <Badge tone="failed">Failed: {phases.failed}</Badge>
            </li>
          </ul>

          <dl className="mt-5 grid gap-5 border-t border-edge pt-4 sm:grid-cols-2">
            <Field label="Autonomous actions">{phases.autonomous}</Field>
            <Field label="Human approval gates">{phases.humanGates}</Field>
          </dl>

          {phases.failed > 0 && (
            <p className="mt-4 rounded-md border border-attempted/40 bg-attempted/5 px-3 py-2.5 text-xs text-attempted">
              Attempted exceeds succeeded because {phases.failed} action(s) genuinely failed.
              Those records are kept deliberately — see the{" "}
              <Link href="/activity" className="underline underline-offset-4">
                activity log
              </Link>
              .
            </p>
          )}
        </Panel>

        {/* --------------------------------------------------- observed outcome */}
        <Panel title="Observed delivery" subtitle="Facts CollabOS witnessed directly">
          {deliverable ? (
            <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Due">
                <code className="font-mono text-xs">
                  {deliverable.dueAt?.toISOString().slice(0, 19).replace("T", " ") ?? "—"}
                </code>
              </Field>
              <Field label="Submitted">
                <code className="font-mono text-xs">
                  {deliverable.submittedAt?.toISOString().slice(0, 19).replace("T", " ") ??
                    "not submitted"}
                </code>
              </Field>
              <Field label="On time">
                {outcome ? (
                  <Badge tone={outcome.submittedOnTime ? "succeeded" : "attempted"}>
                    {outcome.submittedOnTime ? "yes" : `${outcome.hoursLate?.toFixed(1)}h late`}
                  </Badge>
                ) : (
                  <span className="text-ink-faint">—</span>
                )}
              </Field>
              <Field label="Reminder needed">
                {outcome ? (
                  <Badge tone={outcome.neededFollowUp ? "attempted" : "succeeded"}>
                    {outcome.neededFollowUp ? "yes" : "no"}
                  </Badge>
                ) : (
                  <span className="text-ink-faint">—</span>
                )}
              </Field>
            </dl>
          ) : (
            <p className="text-sm text-ink-faint">No deliverable recorded.</p>
          )}
        </Panel>

        {/* ------------------------------------------------ relationship memory */}
        <Panel
          title="Relationship memory after this campaign"
          subtitle="What the next recommendation will reason over"
        >
          {outcome && (
            <div className="mb-4 rounded-lg border border-edge bg-surface-inset/50 px-4 py-3">
              <p className="text-xs font-medium tracking-wide text-ink-faint uppercase">
                Reliability updated
              </p>
              <p className="mt-1.5 text-sm text-ink">
                <span className="font-mono">{outcome.reliabilityBefore ?? "none"}</span>
                {" → "}
                <span className="font-mono text-succeeded">{outcome.reliabilityAfter}</span>
              </p>
              <p className="mt-1.5 text-xs text-ink-faint">
                Computed from the observed facts above by a documented formula — derived, not
                measured.
              </p>
            </div>
          )}

          <ul className="space-y-2">
            {relationships.map((rel) => (
              <li
                key={rel.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
              >
                <span
                  className={
                    rel.partnerId === campaign.approvedPartnerId
                      ? "font-medium text-ink"
                      : "text-ink-muted"
                  }
                >
                  {rel.partner.name}
                </span>
                <Badge tone={rel.status === "collaborated" ? "succeeded" : "attempted"}>
                  {rel.status}
                </Badge>
                <span className="text-ink-muted">
                  {rel.collaborationCount} collaboration
                  {rel.collaborationCount === 1 ? "" : "s"}
                </span>
                {rel.reliabilityScore !== null && (
                  <span className="font-mono text-xs text-ink-faint">
                    reliability {rel.reliabilityScore}
                  </span>
                )}
                {rel.performanceScore !== null && (
                  <span className="font-mono text-xs text-ink-faint">
                    creator-reported {rel.performanceScore}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Panel>

        {/* ------------------------------------------------------ Mind debrief */}
        <Panel title="Mind debrief" subtitle="Guidance for the next partner choice">
          {outcome?.futurePartnerGuidance ? (
            <div className="space-y-4">
              <div className="grid gap-5 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-medium tracking-wide text-ink-faint uppercase">
                    What worked
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {outcome.whatWorked.map((item, i) => (
                      <li key={i} className="text-sm text-ink">
                        + {item}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="text-xs font-medium tracking-wide text-ink-faint uppercase">
                    What to improve
                  </p>
                  {outcome.whatToImprove.length ? (
                    <ul className="mt-2 space-y-1.5">
                      {outcome.whatToImprove.map((item, i) => (
                        <li key={i} className="text-sm text-ink">
                          ! {item}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-ink-faint">Nothing noted.</p>
                  )}
                </div>
              </div>

              <div className="border-t border-edge pt-4">
                <Field label="Guidance for future partner choices">
                  {outcome.futurePartnerGuidance}
                </Field>
              </div>
            </div>
          ) : isComplete ? (
            <p className="rounded-md border border-attempted/40 bg-attempted/5 px-3 py-2.5 text-sm text-attempted">
              The campaign completed but no Mind debrief was recorded — the Mind was
              unreachable. Completion deliberately does not depend on it, and no debrief text
              was invented to fill the gap.
            </p>
          ) : (
            <p className="text-sm text-ink-faint">
              A debrief is recorded when the creator approves the final deliverable.
            </p>
          )}
        </Panel>

        {/* -------------------------------------------------------- messages */}
        <Panel title="Messages sent">
          {campaign.messages.length ? (
            <ul className="space-y-2">
              {campaign.messages.map((message) => (
                <li key={message.id} className="flex flex-wrap items-center gap-2.5 text-sm">
                  <Badge tone={message.kind === "follow_up" ? "attempted" : "accent"}>
                    {message.kind.replace(/_/g, " ")}
                  </Badge>
                  <span className="min-w-0 flex-1 text-ink">{message.subject}</span>
                  <TestTransportBadge transport={message.transport} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-faint">No messages sent.</p>
          )}
        </Panel>

        {/* ------------------------------------------- the honesty disclosure */}
        <Panel title="What this report does not claim">
          <ul className="space-y-2.5 text-sm text-ink-muted">
            <li>
              <strong className="text-ink">No audience growth is measured.</strong> CollabOS
              has no analytics integration. There are no view counts, follower deltas, or
              engagement figures anywhere in this report, and none were estimated. The only
              performance number that can exist here is one the creator typed in themselves.
              {outcome?.creatorReportedPerformance !== null &&
              outcome?.creatorReportedPerformance !== undefined ? (
                <>
                  {" "}
                  For this campaign the creator reported{" "}
                  <span className="font-mono text-ink">
                    {outcome.creatorReportedPerformance}
                  </span>
                  .
                </>
              ) : (
                " For this campaign, none was reported."
              )}
            </li>
            <li>
              <strong className="text-ink">Reliability is derived, not observed
              directly.</strong>{" "}
              It is computed from two facts CollabOS did witness — whether the deliverable
              arrived before its deadline, and whether the automated reminder was needed.
            </li>
            <li>
              <strong className="text-ink">All partners are synthetic.</strong> Audience sizes
              are illustrative seed data on the reserved <code className="font-mono">@example.com</code>{" "}
              domain, not measured platform figures.
            </li>
            <li>
              <strong className="text-ink">Email used a local test transport.</strong> Every
              message was captured by Mailpit and never delivered to the public internet. No
              social platform was contacted.
            </li>
          </ul>
        </Panel>
      </div>

      <Footnote />
    </main>
  );
}
