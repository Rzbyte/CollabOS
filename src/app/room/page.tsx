/**
 * C. Collaboration Room (CLAUDE.md §14C).
 *
 * Creator and partner, Circle membership state, shared brief, deliverable, deadline,
 * follow-up status, submission, final approval, and the timeline.
 *
 * The Circle panel reads LIVE state from the platform on every render rather than trusting
 * the stored row. §16 requires that a failed mutation never displays as `circle_added`, and
 * the surest way to honour that is to show what the platform actually reports — including
 * showing an error when it cannot be read, rather than falling back to the local guess.
 */
import Link from "next/link";

import { Footnote, Header } from "../../components/nav.tsx";
import {
  Badge,
  EmptyState,
  Field,
  Panel,
  StatusDot,
  TestTransportBadge,
} from "../../components/ui.tsx";
import {
  ApproveDeliverableForm,
  ApproveOutreachForm,
  RejectDeliverableForm,
  RemoveFromCircleForm,
  RetryAdvanceForm,
} from "../../components/forms.tsx";
import { loadEnv } from "../../env.ts";
import { readCircleState } from "../../lib/circle/service.ts";
import {
  getActivityLog,
  getCurrentCampaign,
  getOutboundMessages,
} from "../../lib/campaign/queries.ts";
import { CampaignStatus, STATUS_LABELS, isTerminal } from "../../lib/campaign/states.ts";
import { collaborationUrl } from "../../lib/links/sign.ts";
import { PHASE_TONE, phaseLabel } from "../phase-style.ts";

export const dynamic = "force-dynamic";

const CIRCLE_TONE = {
  active: "succeeded",
  already_member: "succeeded",
  pending: "attempted",
  failed: "failed",
  removed: "neutral",
} as const;

export default async function CollaborationRoomPage() {
  const env = loadEnv();
  const campaign = await getCurrentCampaign();

  if (!campaign) {
    return (
      <main id="main" className="mx-auto max-w-5xl px-5 py-10 sm:px-8">
        <Header current="room" />
        <EmptyState title="No campaign yet">
          <Link href="/" className="text-accent underline-offset-4 hover:underline">
            Submit a growth objective
          </Link>{" "}
          to start a collaboration.
        </EmptyState>
        <Footnote />
      </main>
    );
  }

  const [circle, messages, timeline] = await Promise.all([
    readCircleState(),
    getOutboundMessages(campaign.id),
    getActivityLog({ campaignId: campaign.id, limit: 200 }),
  ]);

  const partner = campaign.approvedPartner;
  const deliverable = campaign.deliverables[0] ?? null;
  const membership = campaign.circleMembers[0] ?? null;
  const brief = campaign.brief;
  const pendingFinal = campaign.approvals.find(
    (approval) => approval.actionType === "final_deliverable" && approval.status === "pending",
  );
  const collaboratorLink =
    partner && !isTerminal(campaign.status) ? collaborationUrl(campaign.id) : null;

  return (
    <main id="main" className="mx-auto max-w-5xl px-5 py-10 sm:px-8">
      <Header current="room" />

      <div className="grid gap-5 lg:grid-cols-3">
        {/* -------------------------------------------------------- participants */}
        <Panel
          title="Collaboration"
          className="lg:col-span-2"
          actions={<Badge tone="accent">{STATUS_LABELS[campaign.status]}</Badge>}
        >
          <div className="flex flex-wrap items-center gap-4">
            <div className="rounded-lg border border-edge bg-surface-inset/50 px-4 py-3">
              <p className="text-xs tracking-wide text-ink-faint uppercase">Creator</p>
              <p className="mt-0.5 font-medium">{campaign.creator.name}</p>
              <p className="text-sm text-ink-muted">{campaign.creator.niche}</p>
            </div>

            <span aria-hidden="true" className="text-2xl text-ink-faint">
              ⇄
            </span>

            <div className="rounded-lg border border-edge bg-surface-inset/50 px-4 py-3">
              <p className="text-xs tracking-wide text-ink-faint uppercase">Partner</p>
              {partner ? (
                <>
                  <p className="mt-0.5 font-medium">{partner.name}</p>
                  <p className="text-sm text-ink-muted">{partner.niche}</p>
                </>
              ) : (
                <p className="mt-0.5 text-sm text-ink-faint">Not yet approved</p>
              )}
            </div>
          </div>

          <div className="mt-5 border-t border-edge pt-4">
            <Field label="Growth objective">{campaign.objective}</Field>
          </div>

          {/* The second human gate, surfaced where the collaboration is managed. */}
          {campaign.status === CampaignStatus.outreach_approval_required && partner && (
            <div className="mt-5 rounded-lg border border-attempted/45 bg-attempted/5 px-4 py-3.5">
              <p className="text-sm font-semibold text-attempted">
                Your approval is required before any contact
              </p>
              <div className="mt-3">
                <ApproveOutreachForm campaignId={campaign.id} partnerName={partner.name} />
              </div>
            </div>
          )}

          {/* Honest recovery affordance when an external step failed mid-setup. */}
          {(campaign.status === CampaignStatus.circle_add_pending ||
            campaign.status === CampaignStatus.circle_added ||
            campaign.status === CampaignStatus.outreach_approved) && (
            <div className="mt-5 rounded-lg border border-failed/40 bg-failed/5 px-4 py-3.5">
              <p className="text-sm font-semibold text-failed">Setup did not complete</p>
              <p className="mt-1 text-sm text-ink-muted">
                The campaign is stopped at{" "}
                <code className="font-mono text-xs">{campaign.status}</code> because an
                external step failed. Nothing has been marked as succeeded. See the activity
                log for the recorded failure.
              </p>
              <div className="mt-3">
                <RetryAdvanceForm campaignId={campaign.id} />
              </div>
            </div>
          )}
        </Panel>

        {/* ------------------------------------------------------------- circle */}
        <Panel title="Mind Circle" subtitle="Live platform state">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-ink-muted">Local record</span>
              {membership ? (
                <Badge tone={CIRCLE_TONE[membership.status]}>{membership.status}</Badge>
              ) : (
                <Badge tone="neutral">none</Badge>
              )}
            </div>

            {membership && (
              <p className="wrap-anywhere font-mono text-xs text-ink-faint">
                {membership.collaboratorEmail}
              </p>
            )}

            {/*
              A stored "active" row was written from a confirmed platform read-back. But if
              the platform cannot be reached NOW, presenting that row as current fact would
              overstate what CollabOS knows — so it is explicitly marked unverified.
            */}
            {membership &&
              !circle.members &&
              (membership.status === "active" || membership.status === "already_member") && (
                <p className="rounded-md border border-attempted/40 bg-attempted/5 px-3 py-2 text-xs text-attempted">
                  Unverified right now — this reflects the last confirmed platform response,
                  not a live check.
                </p>
              )}

            <div className="border-t border-edge pt-3">
              <p className="text-xs tracking-wide text-ink-faint uppercase">
                Platform membership
              </p>

              {circle.members ? (
                circle.members.length ? (
                  <ul className="mt-2 space-y-1.5">
                    {circle.members.map((member) => (
                      <li key={member.email} className="flex items-center gap-2 text-sm">
                        <StatusDot tone={member.isSteward ? "accent" : "succeeded"} />
                        <span className="min-w-0 truncate font-mono text-xs">
                          {member.email}
                        </span>
                        {member.isSteward && <Badge tone="accent">Steward</Badge>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-ink-faint">Circle is empty.</p>
                )
              ) : (
                <p className="mt-2 rounded-md border border-failed/35 bg-failed/5 px-3 py-2 text-xs text-failed">
                  Cannot read Circle state: {circle.error}. CollabOS will not display a
                  membership it has not confirmed.
                </p>
              )}
            </div>

            {membership?.addedAt && (
              <p className="border-t border-edge pt-3 font-mono text-xs text-ink-faint">
                added {membership.addedAt.toISOString().replace("T", " ").slice(0, 19)}Z
              </p>
            )}

            {isTerminal(campaign.status) && membership?.status !== "removed" && (
              <div className="border-t border-edge pt-3">
                <RemoveFromCircleForm campaignId={campaign.id} />
              </div>
            )}
          </div>
        </Panel>

        {/* -------------------------------------------------------------- brief */}
        <Panel
          title="Shared campaign brief"
          subtitle="Authored by the Mind, visible to both participants"
          className="lg:col-span-2"
        >
          {brief ? (
            <div className="space-y-4">
              <h3 className="text-base font-semibold text-ink">{brief.title}</h3>
              <p className="text-sm text-ink-muted">{brief.summary}</p>

              <div>
                <p className="text-xs font-medium tracking-wide text-ink-faint uppercase">
                  Talking points
                </p>
                <ul className="mt-2 space-y-1.5">
                  {brief.talkingPoints.map((point, index) => (
                    <li key={index} className="flex gap-2 text-sm text-ink">
                      <span aria-hidden="true" className="text-accent">
                        →
                      </span>
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <dl className="grid gap-4 border-t border-edge pt-4 sm:grid-cols-2">
                {brief.toneNotes && <Field label="Tone">{brief.toneNotes}</Field>}
                {brief.successMetric && (
                  <Field label="Success metric">{brief.successMetric}</Field>
                )}
              </dl>
            </div>
          ) : (
            <EmptyState title="No brief yet">
              The brief is authored by the Mind once the partner accepts.
            </EmptyState>
          )}
        </Panel>

        {/* -------------------------------------------------------- deliverable */}
        <Panel title="Deliverable">
          {deliverable ? (
            <dl className="space-y-4">
              <Field label="Title">{deliverable.title}</Field>
              <Field label="Status">
                <Badge
                  tone={
                    deliverable.status === "approved"
                      ? "succeeded"
                      : deliverable.status === "submitted"
                        ? "attempted"
                        : "neutral"
                  }
                >
                  {deliverable.status.replace(/_/g, " ")}
                </Badge>
              </Field>
              {deliverable.dueAt && (
                <Field label="Due">
                  <code className="font-mono text-xs">
                    {deliverable.dueAt.toISOString().replace("T", " ").slice(0, 19)}Z
                  </code>
                </Field>
              )}
              <Field label="Follow-ups sent">
                {campaign.followUpCount}
                <span className="text-ink-faint"> / 1 max</span>
              </Field>
              {deliverable.submissionUrl && (
                <Field label="Submission">
                  {/* Collaborator-supplied text, rendered as text — never as a live link. */}
                  <code className="block wrap-anywhere font-mono text-xs text-ink-muted">
                    {deliverable.submissionUrl}
                  </code>
                </Field>
              )}
              {deliverable.submissionNote && (
                <Field label="Note from collaborator">{deliverable.submissionNote}</Field>
              )}
            </dl>
          ) : (
            <EmptyState title="No deliverable yet" />
          )}

          {pendingFinal && (
            <div className="mt-5 space-y-4 border-t border-edge pt-4">
              <p className="text-sm font-semibold text-attempted">
                Your final approval is required
              </p>
              <ApproveDeliverableForm campaignId={campaign.id} />
              <div className="border-t border-edge pt-4">
                <RejectDeliverableForm campaignId={campaign.id} />
              </div>
            </div>
          )}

          {campaign.status === CampaignStatus.completed && (
            <div className="mt-4 rounded-md border border-succeeded/40 bg-succeeded/5 px-3.5 py-3">
              <p className="text-sm font-medium text-succeeded">Campaign completed</p>
              <Link
                href="/report"
                className="mt-1 inline-block text-sm text-accent underline-offset-4 hover:underline"
              >
                View the campaign report →
              </Link>
            </div>
          )}
        </Panel>

        {/* ------------------------------------------------- collaborator access */}
        <Panel
          title="Collaborator access"
          subtitle="Signed link — the only way in, and it carries no account"
          className="lg:col-span-3"
        >
          {collaboratorLink ? (
            <>
              <code className="block wrap-anywhere rounded-md border border-edge bg-surface-inset px-3 py-2.5 font-mono text-xs text-ink-muted">
                {collaboratorLink}
              </code>
              <p className="mt-3 text-sm text-ink-muted">
                This link was emailed to the partner through the local test transport. Open{" "}
                <a
                  href={env.mailpitWebUrl}
                  className="text-accent underline-offset-4 hover:underline"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  the Mailpit inbox
                </a>{" "}
                to read the captured message, or use the link directly to act as the
                collaborator.
              </p>
              <div className="mt-3">
                <TestTransportBadge transport={env.EMAIL_TRANSPORT} />
              </div>
            </>
          ) : (
            <p className="text-sm text-ink-faint">
              A collaborator link is generated once a partner is approved.
            </p>
          )}
        </Panel>

        {/* ------------------------------------------------------------ messages */}
        <Panel
          title="Messages sent"
          subtitle="Exactly what the test transport delivered"
          className="lg:col-span-3"
        >
          {messages.length ? (
            <ul className="space-y-3">
              {messages.map((message) => (
                <li key={message.id} className="rounded-lg border border-edge bg-surface-inset/40">
                  <div className="flex flex-wrap items-center gap-2.5 border-b border-edge px-3.5 py-2.5">
                    <Badge tone={message.kind === "follow_up" ? "attempted" : "accent"}>
                      {message.kind.replace(/_/g, " ")}
                    </Badge>
                    <TestTransportBadge transport={message.transport} />
                    <span className="font-mono text-xs text-ink-faint">
                      to {message.toEmail}
                    </span>
                    {message.sentAt && (
                      <span className="font-mono text-xs text-ink-faint">
                        {message.sentAt.toISOString().replace("T", " ").slice(0, 19)}Z
                      </span>
                    )}
                  </div>
                  <div className="px-3.5 py-3">
                    <p className="text-sm font-medium text-ink">{message.subject}</p>
                    <pre className="mt-2 font-sans text-sm whitespace-pre-wrap text-ink-muted">
                      {message.body}
                    </pre>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-faint">Nothing has been sent yet.</p>
          )}
        </Panel>

        {/* ------------------------------------------------------------ timeline */}
        <Panel title="Timeline" className="lg:col-span-3">
          {timeline.length ? (
            <ol className="divide-y divide-edge">
              {timeline.map((event, index) => (
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
            </ol>
          ) : (
            <p className="text-sm text-ink-faint">No activity for this campaign yet.</p>
          )}
        </Panel>
      </div>

      <Footnote />
    </main>
  );
}
