/**
 * B. Partner Review (CLAUDE.md §14B).
 *
 * Layout choices are load-bearing here:
 *
 *  • Fit score and audience RELEVANCE are given the prominent positions; raw audience
 *    size is rendered small, muted, and labelled "not a ranking criterion". §14B
 *    requires that follower size not dominate, and the seeded data is arranged so a
 *    size-driven ranking would be visibly wrong.
 *  • "Memory used" is its own titled block rather than a footnote, because it is the
 *    evidence that persistent relationship history changed the outcome.
 *  • A brand-safety-blocked candidate cannot be approved — the control is replaced, not
 *    merely styled as disabled, and the reason is stated.
 */
import Link from "next/link";

import { ApprovePartnerForm, RejectPartnerForm } from "../../components/forms.tsx";
import { Footnote, Header } from "../../components/nav.tsx";
import { Badge, EmptyState, Panel } from "../../components/ui.tsx";
import { getCurrentCampaign, getRecommendations } from "../../lib/campaign/queries.ts";
import { CampaignStatus, STATUS_LABELS } from "../../lib/campaign/states.ts";
import type { RecommendationView } from "../../lib/campaign/queries.ts";

export const dynamic = "force-dynamic";

const VERDICT_TONE = {
  recommended: "succeeded",
  consider: "attempted",
  reject: "failed",
} as const;

const VERDICT_LABEL = {
  recommended: "Recommended",
  consider: "Consider with caution",
  reject: "Reject",
} as const;

export default async function PartnerReviewPage() {
  const campaign = await getCurrentCampaign();
  const recommendations = campaign ? await getRecommendations(campaign.id) : [];

  const canDecide = campaign?.status === CampaignStatus.partners_recommended;

  return (
    <main id="main" className="mx-auto max-w-5xl px-5 py-10 sm:px-8">
      <Header current="partners" />

      {!campaign ? (
        <EmptyState title="No campaign yet">
          <Link href="/" className="text-accent underline-offset-4 hover:underline">
            Submit a growth objective
          </Link>{" "}
          to get candidate recommendations.
        </EmptyState>
      ) : recommendations.length === 0 ? (
        <EmptyState title="No recommendations recorded">
          {campaign.status === CampaignStatus.objective_submitted ? (
            <>
              The objective was submitted but the Mind has not produced a validated
              ranking. Nothing has been invented in its place — check the{" "}
              <Link href="/activity" className="text-accent underline-offset-4 hover:underline">
                activity log
              </Link>{" "}
              for the recorded failure, then retry from the Command Center.
            </>
          ) : (
            <>
              Campaign state is{" "}
              <code className="font-mono text-xs">{campaign.status}</code>.
            </>
          )}
        </EmptyState>
      ) : (
        <div className="space-y-5">
          <Panel
            title="Creator decision required"
            subtitle={campaign.objective}
            actions={<Badge tone="accent">{STATUS_LABELS[campaign.status]}</Badge>}
          >
            <p className="text-sm text-ink-muted">
              The Mind ranked these candidates using {campaign.creator.name}&apos;s brand
              constraints and stored relationship history. CollabOS will not contact
              anyone until you approve a partner — and then outreach needs a second,
              separate approval.
            </p>
            {!canDecide && (
              <p className="mt-3 rounded-md border border-edge-strong bg-surface-inset px-3 py-2 text-sm text-ink-muted">
                A partner has already been chosen for this campaign, so the controls below
                are read-only.
              </p>
            )}
          </Panel>

          <ol className="space-y-5">
            {recommendations.map((rec) => (
              <li key={rec.id}>
                <CandidateCard
                  rec={rec}
                  campaignId={campaign.id}
                  canDecide={canDecide}
                  isApproved={campaign.approvedPartnerId === rec.partner.id}
                />
              </li>
            ))}
          </ol>
        </div>
      )}

      <Footnote />
    </main>
  );
}

function CandidateCard({
  rec,
  campaignId,
  canDecide,
  isApproved,
}: {
  rec: RecommendationView;
  campaignId: string;
  canDecide: boolean;
  isApproved: boolean;
}) {
  const blocked = rec.safety.blocked;

  return (
    <article
      className={`rounded-xl border bg-surface-raised/60 ${
        blocked
          ? "border-failed/45"
          : isApproved
            ? "border-succeeded/55"
            : "border-edge"
      }`}
    >
      {/* ------------------------------------------------------------ header */}
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-edge px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <span
              aria-label={`Rank ${rec.rank}`}
              className="flex size-7 shrink-0 items-center justify-center rounded-full border border-edge-strong font-mono text-xs text-ink-muted"
            >
              {rec.rank}
            </span>
            <h2 className="text-lg font-semibold text-ink">{rec.partner.name}</h2>
            {rec.partner.isSynthetic && <Badge tone="neutral">Synthetic</Badge>}
            {isApproved && <Badge tone="succeeded">Approved partner</Badge>}
          </div>
          <p className="mt-1.5 text-sm text-ink-muted">{rec.partner.niche}</p>
        </div>

        <div className="flex flex-col items-end gap-2">
          <Badge tone={VERDICT_TONE[rec.recommendation]}>
            {VERDICT_LABEL[rec.recommendation]}
          </Badge>
          <div className="text-right">
            <p className="font-mono text-2xl leading-none font-semibold text-ink">
              {Math.round(rec.fitScore)}
            </p>
            <p className="text-xs tracking-wide text-ink-faint uppercase">fit score</p>
          </div>
        </div>
      </header>

      <div className="space-y-5 px-5 py-4">
        {/* Hard boundary first — it overrides everything else on the card. */}
        {blocked && rec.safety.explanation && (
          <div className="rounded-lg border border-failed/45 bg-failed/8 px-4 py-3">
            <p className="text-sm font-semibold text-failed">
              Blocked by brand-safety boundary
            </p>
            <p className="mt-1 text-sm text-ink-muted">{rec.safety.explanation}</p>
          </div>
        )}

        {/* --------------------------------------------------- audience fit */}
        <div>
          <h3 className="text-xs font-medium tracking-wide text-ink-faint uppercase">
            Audience fit
          </h3>
          <p className="mt-1.5 text-sm text-ink">{rec.partner.audienceDescription}</p>
          {/* Intentionally small and de-emphasised. */}
          <p className="mt-2 font-mono text-xs text-ink-faint">
            audience ≈ {rec.partner.audienceSize.toLocaleString("en-US")} · not a ranking
            criterion on its own
          </p>
        </div>

        {/* ---------------------------------------------- relationship memory */}
        <div className="rounded-lg border border-edge bg-surface-inset/50 px-4 py-3">
          <h3 className="text-xs font-medium tracking-wide text-ink-faint uppercase">
            Relationship history
          </h3>
          {rec.relationship ? (
            <dl className="mt-2 grid gap-x-5 gap-y-2 sm:grid-cols-2">
              <div className="flex gap-2 text-sm">
                <dt className="text-ink-faint">Status</dt>
                <dd className="text-ink">{rec.relationship.status}</dd>
              </div>
              <div className="flex gap-2 text-sm">
                <dt className="text-ink-faint">Collaborations</dt>
                <dd className="text-ink">{rec.relationship.collaborationCount}</dd>
              </div>
              {rec.relationship.reliabilityScore !== null && (
                <div className="flex gap-2 text-sm">
                  <dt className="text-ink-faint">Reliability</dt>
                  <dd className="text-ink">{rec.relationship.reliabilityScore}</dd>
                </div>
              )}
              {rec.relationship.performanceScore !== null && (
                <div className="flex gap-2 text-sm">
                  <dt className="text-ink-faint">Past performance</dt>
                  <dd className="text-ink">{rec.relationship.performanceScore}</dd>
                </div>
              )}
              {rec.relationship.preferredCommunicationStyle && (
                <div className="flex gap-2 text-sm sm:col-span-2">
                  <dt className="shrink-0 text-ink-faint">Prefers</dt>
                  <dd className="text-ink">
                    {rec.relationship.preferredCommunicationStyle}
                  </dd>
                </div>
              )}
              {rec.relationship.previousResponse && (
                <div className="flex gap-2 text-sm sm:col-span-2">
                  <dt className="shrink-0 text-ink-faint">Last response</dt>
                  <dd className="text-ink">{rec.relationship.previousResponse}</dd>
                </div>
              )}
              {rec.relationship.rejectionReason && (
                <div className="flex gap-2 text-sm sm:col-span-2">
                  <dt className="shrink-0 text-ink-faint">Declined because</dt>
                  <dd className="text-attempted">{rec.relationship.rejectionReason}</dd>
                </div>
              )}
            </dl>
          ) : (
            <p className="mt-1.5 text-sm text-ink-faint">
              No prior contact or collaboration on record.
            </p>
          )}
        </div>

        {/* ------------------------------------------------------- reasoning */}
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <h3 className="text-xs font-medium tracking-wide text-ink-faint uppercase">
              Reasons
            </h3>
            <ul className="mt-2 space-y-1.5">
              {rec.reasons.map((reason, index) => (
                <li key={index} className="flex gap-2 text-sm text-ink">
                  <span aria-hidden="true" className="mt-0.5 text-succeeded">
                    +
                  </span>
                  <span>{reason}</span>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="text-xs font-medium tracking-wide text-ink-faint uppercase">
              Risks
            </h3>
            {rec.risks.length ? (
              <ul className="mt-2 space-y-1.5">
                {rec.risks.map((risk, index) => (
                  <li key={index} className="flex gap-2 text-sm text-ink">
                    <span aria-hidden="true" className="mt-0.5 text-attempted">
                      !
                    </span>
                    <span>{risk}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-ink-faint">None identified.</p>
            )}
          </div>
        </div>

        {/* ----------------------------------------------------- memory used */}
        <div>
          <h3 className="text-xs font-medium tracking-wide text-ink-faint uppercase">
            Memory used in this decision
          </h3>
          {rec.memoryUsed.length ? (
            <ul className="mt-2 flex flex-wrap gap-2">
              {rec.memoryUsed.map((memory, index) => (
                <li
                  key={index}
                  className="rounded-md border border-accent/35 bg-accent/8 px-2.5 py-1 text-xs text-accent"
                >
                  {memory}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-ink-faint">
              No stored history was available for this candidate.
            </p>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------ controls */}
      <footer className="flex flex-wrap items-start justify-between gap-4 border-t border-edge px-5 py-4">
        <div className="text-xs text-ink-faint">
          {rec.rawMindResponseReference && (
            <span className="font-mono">
              mind exchange {rec.rawMindResponseReference.slice(0, 8)}
            </span>
          )}
        </div>

        {canDecide ? (
          rec.rejectedByCreator ? (
            <Badge tone="failed">You rejected this partner</Badge>
          ) : (
            <div className="flex flex-wrap items-start gap-3">
              <RejectPartnerForm campaignId={campaignId} partnerId={rec.partner.id} />
              <ApprovePartnerForm
                campaignId={campaignId}
                partnerId={rec.partner.id}
                partnerName={rec.partner.name}
                disabled={blocked || rec.relationship?.optedOut}
                {...(blocked
                  ? {
                      disabledReason:
                        "Blocked by a hard brand-safety boundary. This cannot be overridden from the UI.",
                    }
                  : rec.relationship?.optedOut
                    ? {
                        disabledReason:
                          "This partner has opted out of outreach and must not be contacted.",
                      }
                    : {})}
              />
            </div>
          )
        ) : (
          <span className="text-xs text-ink-faint">Decision already recorded</span>
        )}
      </footer>
    </article>
  );
}
