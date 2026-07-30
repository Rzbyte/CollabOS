/**
 * Collaborator page — the partner's view, reached only via a signed link.
 *
 * Intentionally minimal (§17: "a minimal collaborator page"). It is UNAUTHENTICATED, so the
 * design principle is that the token grants visibility into exactly one campaign and the
 * ability to take exactly two actions: accept, and submit.
 *
 * Nothing sensitive about the creator is exposed — no prohibited-topic list, no partner
 * scoring, no fit reasoning, no other candidates. A collaborator must not be able to read
 * how they were ranked against the alternatives (§18: "sharing private creator information"
 * is prohibited).
 */
import {
  AcceptCollaborationForm,
  SubmitDeliverableForm,
} from "../../../components/forms.tsx";
import { Badge, EmptyState, Field, Panel } from "../../../components/ui.tsx";
import { prisma } from "../../../lib/db.ts";
import { CampaignStatus, STATUS_LABELS } from "../../../lib/campaign/states.ts";
import { InvalidLinkError, verifyCollaborationToken } from "../../../lib/links/sign.ts";

export const dynamic = "force-dynamic";

export default async function CollaboratorPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  let campaignId: string;
  try {
    campaignId = verifyCollaborationToken(token).campaignId;
  } catch (error) {
    const message =
      error instanceof InvalidLinkError
        ? error.message
        : "This collaboration link could not be verified.";

    return (
      <main id="main" className="mx-auto max-w-2xl px-5 py-16 sm:px-8">
        <h1 className="text-xl font-semibold">CollabOS</h1>
        <div className="mt-6 rounded-xl border border-failed/45 bg-failed/5 px-5 py-4">
          <p className="text-sm font-semibold text-failed">Link not valid</p>
          <p className="mt-1.5 text-sm text-ink-muted">{message}</p>
        </div>
      </main>
    );
  }

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: {
      creator: true,
      approvedPartner: true,
      brief: true,
      deliverables: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!campaign) {
    return (
      <main id="main" className="mx-auto max-w-2xl px-5 py-16 sm:px-8">
        <h1 className="text-xl font-semibold">CollabOS</h1>
        <EmptyState title="This collaboration no longer exists." />
      </main>
    );
  }

  const deliverable = campaign.deliverables[0] ?? null;
  const canAccept = campaign.status === CampaignStatus.outreach_sent;
  const canSubmit =
    campaign.status === CampaignStatus.awaiting_deliverable ||
    campaign.status === CampaignStatus.follow_up_due ||
    campaign.status === CampaignStatus.follow_up_sent;
  const submitted =
    campaign.status === CampaignStatus.deliverable_received ||
    campaign.status === CampaignStatus.final_approval_required ||
    campaign.status === CampaignStatus.completed;

  return (
    <main id="main" className="mx-auto max-w-2xl px-5 py-12 sm:px-8">
      <header className="mb-8">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">CollabOS</h1>
          <Badge tone="test">Collaborator view</Badge>
        </div>
        <p className="mt-2 text-sm text-ink-muted">
          You are viewing this through a private link shared by {campaign.creator.name}.
        </p>
      </header>

      <div className="space-y-5">
        <Panel
          title="Collaboration invitation"
          actions={<Badge tone="accent">{STATUS_LABELS[campaign.status]}</Badge>}
        >
          <dl className="space-y-4">
            <Field label="From">
              {campaign.creator.name} — {campaign.creator.niche}
            </Field>
            {campaign.approvedPartner && (
              <Field label="To">{campaign.approvedPartner.name}</Field>
            )}
            <Field label="What this is about">{campaign.objective}</Field>
          </dl>

          {canAccept && (
            <div className="mt-5 border-t border-edge pt-4">
              <p className="mb-3 text-sm text-ink-muted">
                Accepting confirms you are happy to collaborate. You will then see the
                shared brief and can submit your deliverable here.
              </p>
              <AcceptCollaborationForm token={token} />
            </div>
          )}
        </Panel>

        {campaign.brief && (
          <Panel title="Shared brief">
            <h2 className="text-base font-semibold text-ink">{campaign.brief.title}</h2>
            <p className="mt-2 text-sm text-ink-muted">{campaign.brief.summary}</p>

            <div className="mt-4">
              <p className="text-xs font-medium tracking-wide text-ink-faint uppercase">
                Talking points
              </p>
              <ul className="mt-2 space-y-1.5">
                {campaign.brief.talkingPoints.map((point, index) => (
                  <li key={index} className="flex gap-2 text-sm text-ink">
                    <span aria-hidden="true" className="text-accent">
                      →
                    </span>
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </div>

            {campaign.brief.toneNotes && (
              <div className="mt-4 border-t border-edge pt-4">
                <Field label="Tone">{campaign.brief.toneNotes}</Field>
              </div>
            )}
          </Panel>
        )}

        {deliverable && (
          <Panel title="Your deliverable">
            <dl className="space-y-4">
              <Field label="What is needed">{deliverable.title}</Field>
              <Field label="Details">{deliverable.description}</Field>
              {deliverable.dueAt && (
                <Field label="Due by">
                  <code className="font-mono text-xs">
                    {deliverable.dueAt.toISOString().replace("T", " ").slice(0, 19)}Z
                  </code>
                </Field>
              )}
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
            </dl>

            {canSubmit && (
              <div className="mt-5 border-t border-edge pt-4">
                <SubmitDeliverableForm token={token} />
              </div>
            )}

            {submitted && deliverable.submissionUrl && (
              <div className="mt-5 rounded-md border border-succeeded/40 bg-succeeded/5 px-3.5 py-3">
                <p className="text-sm font-medium text-succeeded">
                  Submitted — thank you.
                </p>
                <p className="mt-1 text-sm text-ink-muted">
                  {campaign.status === CampaignStatus.completed
                    ? "The creator has approved your work and the campaign is complete."
                    : "Waiting for the creator to review and approve."}
                </p>
              </div>
            )}
          </Panel>
        )}

        {campaign.status === CampaignStatus.cancelled && (
          <Panel title="Campaign cancelled">
            <p className="text-sm text-ink-muted">
              This collaboration was cancelled. No further action is needed.
            </p>
          </Panel>
        )}
      </div>

      <footer className="mt-10 border-t border-edge pt-5 text-xs text-ink-faint">
        <p>
          This is a local demonstration environment. Email is captured by a local test
          transport and never delivered externally.
        </p>
      </footer>
    </main>
  );
}
