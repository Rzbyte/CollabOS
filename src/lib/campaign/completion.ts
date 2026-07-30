/**
 * Completion loop — final approval, campaign completion, and the relationship write-back.
 *
 * This is where the "learns which partnerships actually grow the audience" claim has to be
 * handled carefully, because it is the easiest place in the whole system to start inventing
 * data. The rule applied here:
 *
 *   • Reliability IS updated, from facts CollabOS genuinely observed — did the partner
 *     submit before the deadline, and did they need the automated reminder. Both are
 *     recorded in the database, not guessed.
 *   • Audience performance is NOT updated automatically. CollabOS has no analytics
 *     integration, so any figure it produced would be fabricated (§18). The field is only
 *     ever written from an explicit creator-reported value, and stays null otherwise.
 *
 * Completion also never depends on the Mind. The debrief is best-effort: if the Mind is
 * unreachable the campaign still completes, the relationship is still updated, and the
 * failure is recorded as its own audit row.
 */
import { ApprovalActionType, ApprovalStatus } from "../../generated/prisma/enums.ts";
import { DeliverableStatus, RelationshipStatus } from "../../generated/prisma/enums.ts";
import {
  beginAction,
  logApproval,
  logEvent,
  markAttempted,
  markFailed,
  markSucceeded,
} from "../audit/log.ts";
import { getClock } from "../clock.ts";
import { prisma } from "../db.ts";
import { getMindsPort, newCorrelationId, type MindsPort } from "../minds/client.ts";
import { toCollabOsMindsError } from "../minds/errors.ts";
import { buildCampaignDebriefPrompt } from "../minds/prompts.ts";
import { requestCampaignDebrief } from "../minds/reasoning.ts";
import { CampaignStatus } from "./states.ts";
import { transitionCampaign } from "./transition.ts";

export interface CompletionResult {
  ok: boolean;
  reached: CampaignStatus;
  /** True when the relationship record was updated. */
  relationshipUpdated: boolean;
  /** False when the Mind debrief was unavailable — completion succeeds regardless. */
  debriefRecorded: boolean;
  steps: string[];
  error?: { code: string; message: string };
}

/**
 * Reliability derived from observed delivery behaviour.
 *
 * A documented heuristic over facts CollabOS witnessed — deliberately not presented as a
 * measurement. Exposed as a named function so the report can explain how the number arose
 * and the test suite can pin the behaviour.
 *
 * Prior scores are blended rather than replaced, so a single collaboration cannot swing a
 * long history, and a partner with no history simply takes the observed value.
 */
export function computeReliability(input: {
  prior: number | null;
  submittedOnTime: boolean;
  neededFollowUp: boolean;
}): number {
  const observed = input.submittedOnTime
    ? input.neededFollowUp
      ? 0.8 // delivered by the deadline, but only after a reminder
      : 1.0 // delivered by the deadline unprompted
    : input.neededFollowUp
      ? 0.45 // late and needed chasing
      : 0.65; // late, but delivered without being chased

  if (input.prior === null) return round2(observed);

  // 60% history, 40% this collaboration.
  return round2(input.prior * 0.6 + observed * 0.4);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The creator approves the finished deliverable and the campaign completes.
 *
 * `creatorReportedPerformance` is optional and, when supplied, is stored as an explicitly
 * creator-reported figure. It is never inferred.
 */
export async function approveDeliverable(input: {
  campaignId: string;
  creatorReportedPerformance?: number | null;
  port?: MindsPort;
}): Promise<CompletionResult> {
  const port = input.port ?? getMindsPort();
  const correlationId = newCorrelationId();
  const now = getClock().now();
  const steps: string[] = [];

  const campaign = await prisma.campaign.findUnique({
    where: { id: input.campaignId },
    include: {
      creator: true,
      approvedPartner: true,
      deliverables: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!campaign) throw new Error(`Campaign ${input.campaignId} not found.`);

  // Idempotency: already finished.
  if (campaign.status === CampaignStatus.completed) {
    return {
      ok: true,
      reached: CampaignStatus.completed,
      relationshipUpdated: false,
      debriefRecorded: false,
      steps: ["campaign already completed"],
    };
  }

  if (campaign.status !== CampaignStatus.final_approval_required) {
    throw new Error(
      `Cannot approve the deliverable while the campaign is in state "${campaign.status}".`,
    );
  }

  const partner = campaign.approvedPartner;
  const deliverable = campaign.deliverables[0];
  if (!partner || !deliverable) {
    throw new Error("Campaign is missing an approved partner or a deliverable.");
  }

  // ---------------------------------------------------- record the human decision
  const pending = await prisma.approval.findFirst({
    where: {
      campaignId: campaign.id,
      actionType: ApprovalActionType.final_deliverable,
      status: ApprovalStatus.pending,
    },
  });

  if (pending) {
    await prisma.approval.update({
      where: { id: pending.id },
      data: { status: ApprovalStatus.approved, approvedAt: now },
    });
  }

  await logApproval({
    campaignId: campaign.id,
    correlationId,
    actionType: "approval.final_deliverable",
    summary: `Creator approved the final deliverable from ${partner.name}`,
    decision: "approved",
    reason: "Human control gate: final deliverable approval is never automatic.",
  });
  steps.push("final deliverable approved");

  await prisma.deliverable.update({
    where: { id: deliverable.id },
    data: { status: DeliverableStatus.approved, approvedAt: now },
  });

  // ------------------------------------------------------------- observed facts
  const submittedAt = deliverable.submittedAt ?? now;
  const dueAt = deliverable.dueAt;
  const submittedOnTime = dueAt ? submittedAt <= dueAt : true;
  const hoursLate =
    dueAt && submittedAt > dueAt
      ? (submittedAt.getTime() - dueAt.getTime()) / 3_600_000
      : null;
  const neededFollowUp = campaign.followUpCount > 0;

  // -------------------------------------------------------------- complete it
  await transitionCampaign({
    campaignId: campaign.id,
    to: CampaignStatus.completed,
    actionType: "campaign.completed",
    summary: `Campaign completed with ${partner.name}`,
    correlationId,
    expectedFrom: [CampaignStatus.final_approval_required],
    campaignData: { nextActionAt: null, lockedBy: null, lockedUntil: null },
  });
  steps.push("campaign completed");

  // ---------------------------------------- relationship write-back (the loop)
  const existing = await prisma.relationship.findUnique({
    where: {
      creatorId_partnerId: { creatorId: campaign.creatorId, partnerId: partner.id },
    },
  });

  const reliabilityBefore = existing?.reliabilityScore ?? null;
  const reliabilityAfter = computeReliability({
    prior: reliabilityBefore,
    submittedOnTime,
    neededFollowUp,
  });

  const reported =
    typeof input.creatorReportedPerformance === "number"
      ? clamp01(input.creatorReportedPerformance)
      : null;

  await prisma.relationship.upsert({
    where: {
      creatorId_partnerId: { creatorId: campaign.creatorId, partnerId: partner.id },
    },
    create: {
      creatorId: campaign.creatorId,
      partnerId: partner.id,
      status: RelationshipStatus.collaborated,
      collaborationCount: 1,
      previousResponse: describeOutcome(submittedOnTime, neededFollowUp),
      reliabilityScore: reliabilityAfter,
      // Only written when the creator actually reported a figure.
      ...(reported !== null ? { performanceScore: reported } : {}),
      lastContactedAt: now,
    },
    update: {
      status: RelationshipStatus.collaborated,
      collaborationCount: { increment: 1 },
      previousResponse: describeOutcome(submittedOnTime, neededFollowUp),
      rejectionReason: null,
      reliabilityScore: reliabilityAfter,
      ...(reported !== null ? { performanceScore: reported } : {}),
      lastContactedAt: now,
    },
  });

  await logEvent({
    campaignId: campaign.id,
    correlationId,
    actionType: "relationship.updated",
    summary:
      `Relationship memory updated for ${partner.name} — collaborations ` +
      `${(existing?.collaborationCount ?? 0) + 1}, reliability ` +
      `${reliabilityBefore ?? "none"} → ${reliabilityAfter}`,
    reason:
      `Computed from observed delivery: on time = ${submittedOnTime}, ` +
      `reminder needed = ${neededFollowUp}. ` +
      (reported !== null
        ? `Creator reported a performance score of ${reported}.`
        : `No audience performance recorded — CollabOS has no analytics integration and ` +
          `will not invent one.`),
  });
  steps.push("relationship memory updated");

  // -------------------------------------------- best-effort Mind debrief
  let debriefRecorded = false;
  let debriefError: { code: string; message: string } | undefined;

  const debriefAction = await beginAction({
    campaignId: campaign.id,
    correlationId,
    actionType: "mind.campaign_debrief",
    summary: `Ask the Mind for a post-campaign debrief`,
    reason: "Feeds the next partner recommendation. Not required for completion.",
  });

  try {
    await markAttempted(debriefAction);
    await port.ensureConversation(campaign.creator.mindConversationAlias);

    const debrief = await requestCampaignDebrief({
      port,
      alias: campaign.creator.mindConversationAlias,
      campaignId: campaign.id,
      correlationId,
      prompt: buildCampaignDebriefPrompt({
        creator: campaign.creator,
        partner,
        relationship: existing,
        objective: campaign.objective,
        submittedOnTime,
        neededFollowUp,
        hoursLate,
      }),
    });

    await prisma.campaignOutcome.upsert({
      where: { campaignId: campaign.id },
      create: {
        campaignId: campaign.id,
        submittedOnTime,
        hoursLate,
        neededFollowUp,
        reliabilityBefore,
        reliabilityAfter,
        creatorReportedPerformance: reported,
        whatWorked: debrief.value.whatWorked,
        whatToImprove: debrief.value.whatToImprove,
        futurePartnerGuidance: debrief.value.futurePartnerGuidance,
        debriefMemoryUsed: debrief.value.memoryUsed,
        debriefExchangeReference: debrief.exchangeId,
      },
      update: {
        whatWorked: debrief.value.whatWorked,
        whatToImprove: debrief.value.whatToImprove,
        futurePartnerGuidance: debrief.value.futurePartnerGuidance,
        debriefMemoryUsed: debrief.value.memoryUsed,
        debriefExchangeReference: debrief.exchangeId,
      },
    });

    await markSucceeded(debriefAction, {
      externalReference: debrief.exchangeId,
      summary: `Mind debrief recorded — guidance stored for future partner choices`,
    });
    debriefRecorded = true;
    steps.push("Mind debrief recorded");
  } catch (error) {
    await markFailed(debriefAction, error);
    const typed = toCollabOsMindsError(error, correlationId);
    debriefError = { code: typed.code, message: typed.message };

    // Still store the observed outcome — the facts do not depend on the Mind.
    await prisma.campaignOutcome.upsert({
      where: { campaignId: campaign.id },
      create: {
        campaignId: campaign.id,
        submittedOnTime,
        hoursLate,
        neededFollowUp,
        reliabilityBefore,
        reliabilityAfter,
        creatorReportedPerformance: reported,
        whatWorked: [],
        whatToImprove: [],
        debriefMemoryUsed: [],
      },
      update: {
        submittedOnTime,
        hoursLate,
        neededFollowUp,
        reliabilityBefore,
        reliabilityAfter,
        creatorReportedPerformance: reported,
      },
    });
    steps.push("outcome recorded without Mind debrief");
  }

  return {
    // The campaign genuinely completed even if the debrief failed.
    ok: true,
    reached: CampaignStatus.completed,
    relationshipUpdated: true,
    debriefRecorded,
    steps,
    ...(debriefError ? { error: debriefError } : {}),
  };
}

/**
 * The creator rejects the submission and asks for a revision.
 *
 * Returns to `awaiting_deliverable`. Note this does NOT re-arm the autonomous follow-up:
 * `followUpCount` is already 1, so the worker's cap suppresses a second reminder. That is
 * exactly why the cap lives on the counter rather than on graph position.
 */
export async function rejectDeliverable(input: {
  campaignId: string;
  note: string;
  revisionSeconds?: number;
}): Promise<CompletionResult> {
  const correlationId = newCorrelationId();
  const now = getClock().now();

  const campaign = await prisma.campaign.findUnique({
    where: { id: input.campaignId },
    include: { approvedPartner: true, deliverables: { orderBy: { createdAt: "asc" } } },
  });
  if (!campaign) throw new Error(`Campaign ${input.campaignId} not found.`);

  if (campaign.status !== CampaignStatus.final_approval_required) {
    throw new Error(
      `Cannot reject the deliverable while the campaign is in state "${campaign.status}".`,
    );
  }

  const deliverable = campaign.deliverables[0];
  if (!deliverable) throw new Error("Campaign has no deliverable.");

  const pending = await prisma.approval.findFirst({
    where: {
      campaignId: campaign.id,
      actionType: ApprovalActionType.final_deliverable,
      status: ApprovalStatus.pending,
    },
  });

  if (pending) {
    await prisma.approval.update({
      where: { id: pending.id },
      data: {
        status: ApprovalStatus.rejected,
        rejectedAt: now,
        decisionNote: input.note.slice(0, 500),
      },
    });
  }

  const revisionDue = new Date(now.getTime() + (input.revisionSeconds ?? 86_400) * 1000);

  await prisma.deliverable.update({
    where: { id: deliverable.id },
    data: {
      status: DeliverableStatus.awaiting_submission,
      submittedAt: null,
      approvedAt: null,
      dueAt: revisionDue,
    },
  });

  await logApproval({
    campaignId: campaign.id,
    correlationId,
    actionType: "approval.deliverable_rejected",
    summary: `Creator requested a revision from ${campaign.approvedPartner?.name ?? "the collaborator"}`,
    decision: "rejected",
    reason: `Note: ${input.note.slice(0, 200)}`,
  });

  await transitionCampaign({
    campaignId: campaign.id,
    to: CampaignStatus.awaiting_deliverable,
    actionType: "campaign.revision_requested",
    summary: `Awaiting a revised deliverable`,
    correlationId,
    expectedFrom: [CampaignStatus.final_approval_required],
    // No new autonomous reminder: one was already sent, and the cap holds.
    campaignData: { deadline: revisionDue, nextActionAt: null },
  });

  return {
    ok: true,
    reached: CampaignStatus.awaiting_deliverable,
    relationshipUpdated: false,
    debriefRecorded: false,
    steps: ["revision requested"],
  };
}

function describeOutcome(onTime: boolean, neededFollowUp: boolean): string {
  if (onTime && !neededFollowUp) {
    return "Delivered the agreed deliverable by the deadline without needing a reminder; creator approved it.";
  }
  if (onTime) {
    return "Delivered the agreed deliverable by the deadline after one reminder; creator approved it.";
  }
  if (neededFollowUp) {
    return "Delivered the agreed deliverable late, after one reminder; creator approved it.";
  }
  return "Delivered the agreed deliverable late; creator approved it.";
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
