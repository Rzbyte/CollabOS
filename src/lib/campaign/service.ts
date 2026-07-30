/**
 * Campaign orchestration.
 *
 * Sequences the deterministic work around each Mind call and enforces the human-control
 * gates from CLAUDE.md §18. Every state change goes through the transition service, and
 * every meaningful step leaves an audit row.
 *
 * The brand-safety layer here is deliberately belt-and-braces: the Mind is asked to
 * reject a conflicting partner AND CollabOS overrides the verdict if it does not. An
 * override is recorded rather than applied silently, because "the Mind recommended a
 * partner it should have rejected" is information worth keeping.
 */
import type { CreatorProfile, Relationship } from "../../generated/prisma/client.ts";
import { ApprovalActionType, ApprovalStatus } from "../../generated/prisma/enums.ts";
import {
  AgentActionStatus,
  beginAction,
  logApproval,
  logEvent,
  markAttempted,
  markFailed,
  markSucceeded,
} from "../audit/log.ts";
import { prisma } from "../db.ts";
import { getMindsPort, newCorrelationId, type MindsPort } from "../minds/client.ts";
import { CollabOsMindsError, toCollabOsMindsError } from "../minds/errors.ts";
import { buildPartnerRankingPrompt, type CandidateContext } from "../minds/prompts.ts";
import { requestPartnerRanking } from "../minds/reasoning.ts";
import {
  BrandSafetyViolationError,
  PartnerContactBlockedError,
  assessPartnerSafety,
} from "../safety/brand-safety.ts";
import { CampaignStatus } from "./states.ts";
import { transitionCampaign } from "./transition.ts";

export class NoCreatorProfileError extends Error {
  readonly code = "NO_CREATOR_PROFILE";
  constructor() {
    super("No creator profile exists. Run `npm run db:seed` to load the demo scenario.");
    this.name = "NoCreatorProfileError";
  }
}

export class ActiveCampaignExistsError extends Error {
  readonly code = "ACTIVE_CAMPAIGN_EXISTS";
  readonly campaignId: string;
  constructor(campaignId: string, status: CampaignStatus) {
    super(
      `A campaign is already in progress (state: ${status}). Complete or cancel it ` +
        `before submitting a new objective.`,
    );
    this.name = "ActiveCampaignExistsError";
    this.campaignId = campaignId;
  }
}

const NON_TERMINAL: CampaignStatus[] = (
  Object.values(CampaignStatus) as CampaignStatus[]
).filter(
  (status) =>
    status !== CampaignStatus.completed &&
    status !== CampaignStatus.cancelled &&
    status !== CampaignStatus.failed,
);

export async function findActiveCampaign() {
  return prisma.campaign.findFirst({
    where: { status: { in: NON_TERMINAL } },
    orderBy: { createdAt: "desc" },
  });
}

export interface SubmitObjectiveResult {
  campaignId: string;
  /** False when the Mind call failed; the campaign still exists and can be retried. */
  recommended: boolean;
  error?: { code: string; message: string };
  overrides?: string[];
}

/**
 * Milestone 3 entry point: objective in, validated recommendations out.
 *
 * On a Mind failure the campaign is intentionally LEFT in `objective_submitted` rather
 * than moved to `failed`. The objective genuinely was submitted, the recommendations
 * genuinely were not produced, and `failed` is near-terminal — leaving it recoverable
 * lets the creator retry once credentials or connectivity are fixed. The failure itself
 * is recorded as a `failed` AgentAction, so nothing is hidden.
 */
export async function submitObjective(input: {
  objective: string;
  port?: MindsPort;
}): Promise<SubmitObjectiveResult> {
  const objective = input.objective.trim();
  if (objective.length < 10) {
    throw new Error("Please describe the growth objective in at least 10 characters.");
  }

  const existing = await findActiveCampaign();
  if (existing) {
    throw new ActiveCampaignExistsError(existing.id, existing.status);
  }

  const creator = await prisma.creatorProfile.findFirst();
  if (!creator) throw new NoCreatorProfileError();

  const correlationId = newCorrelationId();

  const campaign = await prisma.campaign.create({
    data: { creatorId: creator.id, objective, status: CampaignStatus.draft },
  });

  await transitionCampaign({
    campaignId: campaign.id,
    to: CampaignStatus.objective_submitted,
    actionType: "campaign.objective_submitted",
    summary: `Growth objective submitted: "${truncate(objective, 90)}"`,
    correlationId,
  });

  // Loading memory is a real, auditable step — the Mind's context is assembled from
  // Postgres, not recalled from chat history.
  const candidates = await loadCandidates(creator.id);

  await logEvent({
    campaignId: campaign.id,
    correlationId,
    actionType: "memory.loaded",
    summary:
      `Loaded creator brand memory for ${creator.name} — ` +
      `${creator.prohibitedTopics.length} prohibited topic(s), ` +
      `${candidates.filter((c) => c.relationship).length} existing relationship(s)`,
      reason:
      `Brand voice: ${creator.brandVoice}. Target audience: ${creator.targetAudience}.`,
  });

  const actionId = await beginAction({
    campaignId: campaign.id,
    correlationId,
    actionType: "mind.partner_ranking",
    summary: `Evaluate ${candidates.length} partner candidates with the Mind`,
    reason:
      `Ranking against objective and ${creator.name}'s brand constraints using ` +
      `persisted relationship history.`,
  });

  const port = input.port ?? getMindsPort();

  try {
    await markAttempted(actionId);

    await port.ensureConversation(creator.mindConversationAlias);

    const prompt = buildPartnerRankingPrompt({ creator, objective, candidates });
    const candidateIds = candidates.map((c) => c.partner.id);

    const ranking = await requestPartnerRanking({
      port,
      alias: creator.mindConversationAlias,
      campaignId: campaign.id,
      correlationId,
      prompt,
      candidateIds,
    });

    const { overrides, topPartnerName } = await persistRecommendations({
      campaignId: campaign.id,
      creator,
      candidates,
      response: ranking.value,
      exchangeId: ranking.exchangeId,
    });

    await markSucceeded(actionId, {
      externalReference: ranking.exchangeId,
      summary:
        `Evaluated ${candidates.length} candidates — top recommendation: ` +
        `${topPartnerName ?? "none"}` +
        (ranking.requiredRepair ? " (after one schema repair retry)" : ""),
    });

    if (overrides.length) {
      // Recorded, not silenced: the Mind failed to reject a blocked partner.
      await logEvent({
        campaignId: campaign.id,
        correlationId,
        actionType: "safety.override",
        summary:
          `Brand-safety override applied to ${overrides.join(", ")} — ` +
          `CollabOS forced a reject verdict`,
        reason:
          `The Mind did not reject a candidate that conflicts with the creator's ` +
          `prohibited topics. The hard boundary is enforced by CollabOS regardless.`,
      });
    }

    await transitionCampaign({
      campaignId: campaign.id,
      to: CampaignStatus.partners_recommended,
      actionType: "campaign.partners_recommended",
      summary: `Recommended ${topPartnerName ?? "candidates"} for creator review`,
      correlationId,
      expectedFrom: [CampaignStatus.objective_submitted],
    });

    return { campaignId: campaign.id, recommended: true, overrides };
  } catch (error) {
    await markFailed(actionId, error);

    const typed =
      error instanceof CollabOsMindsError ? error : toCollabOsMindsError(error, correlationId);

    return {
      campaignId: campaign.id,
      recommended: false,
      error: { code: typed.code, message: typed.message },
    };
  }
}

/** Re-runs the ranking for a campaign stuck in `objective_submitted`. */
export async function retryRecommendations(input: {
  campaignId: string;
  port?: MindsPort;
}): Promise<SubmitObjectiveResult> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: input.campaignId },
    include: { creator: true },
  });

  if (!campaign) throw new Error(`Campaign ${input.campaignId} not found.`);
  if (
    campaign.status !== CampaignStatus.objective_submitted &&
    campaign.status !== CampaignStatus.partners_recommended
  ) {
    throw new Error(
      `Cannot re-run evaluation from state "${campaign.status}".`,
    );
  }

  const correlationId = newCorrelationId();
  const creator = campaign.creator;
  const candidates = await loadCandidates(creator.id);

  const actionId = await beginAction({
    campaignId: campaign.id,
    correlationId,
    actionType: "mind.partner_ranking",
    summary: `Re-evaluate ${candidates.length} partner candidates with the Mind`,
  });

  const port = input.port ?? getMindsPort();

  try {
    await markAttempted(actionId);
    await port.ensureConversation(creator.mindConversationAlias);

    const ranking = await requestPartnerRanking({
      port,
      alias: creator.mindConversationAlias,
      campaignId: campaign.id,
      correlationId,
      prompt: buildPartnerRankingPrompt({
        creator,
        objective: campaign.objective,
        candidates,
      }),
      candidateIds: candidates.map((c) => c.partner.id),
    });

    const { overrides, topPartnerName } = await persistRecommendations({
      campaignId: campaign.id,
      creator,
      candidates,
      response: ranking.value,
      exchangeId: ranking.exchangeId,
    });

    await markSucceeded(actionId, {
      externalReference: ranking.exchangeId,
      summary: `Re-evaluated candidates — top recommendation: ${topPartnerName ?? "none"}`,
    });

    await transitionCampaign({
      campaignId: campaign.id,
      to: CampaignStatus.partners_recommended,
      actionType: "campaign.partners_recommended",
      summary: `Refreshed recommendations for creator review`,
      correlationId,
    });

    return { campaignId: campaign.id, recommended: true, overrides };
  } catch (error) {
    await markFailed(actionId, error);
    const typed =
      error instanceof CollabOsMindsError ? error : toCollabOsMindsError(error, correlationId);
    return {
      campaignId: campaign.id,
      recommended: false,
      error: { code: typed.code, message: typed.message },
    };
  }
}

async function loadCandidates(creatorId: string): Promise<CandidateContext[]> {
  const [partners, relationships, creator] = await Promise.all([
    prisma.partner.findMany({ orderBy: { name: "asc" } }),
    prisma.relationship.findMany({ where: { creatorId } }),
    prisma.creatorProfile.findUniqueOrThrow({ where: { id: creatorId } }),
  ]);

  const byPartner = new Map<string, Relationship>(
    relationships.map((relationship) => [relationship.partnerId, relationship]),
  );

  return partners.map((partner) => {
    const safety = assessPartnerSafety(creator.prohibitedTopics, partner);
    return {
      partner,
      relationship: byPartner.get(partner.id) ?? null,
      safetyConflicts: safety.conflicts.map(
        (conflict) => `"${conflict.partnerFlag}" vs prohibited "${conflict.prohibitedTopic}"`,
      ),
    };
  });
}

async function persistRecommendations(input: {
  campaignId: string;
  creator: CreatorProfile;
  candidates: CandidateContext[];
  response: { recommendations: Array<{
    partnerId: string;
    rank: number;
    fitScore: number;
    recommendation: "recommended" | "consider" | "reject";
    reasons: string[];
    risks: string[];
    memoryUsed: string[];
  }> };
  exchangeId: string;
}): Promise<{ overrides: string[]; topPartnerName: string | null }> {
  const byId = new Map(input.candidates.map((c) => [c.partner.id, c]));
  const overrides: string[] = [];

  await prisma.$transaction(async (tx) => {
    // Replace wholesale so a re-run never leaves stale rows behind.
    await tx.partnerRecommendation.deleteMany({ where: { campaignId: input.campaignId } });

    for (const item of input.response.recommendations) {
      const candidate = byId.get(item.partnerId);
      if (!candidate) continue; // Semantic validation already rejected unknown ids.

      const safety = assessPartnerSafety(
        input.creator.prohibitedTopics,
        candidate.partner,
      );

      let verdict = item.recommendation;
      const risks = [...item.risks];

      if (safety.blocked) {
        if (verdict !== "reject") {
          overrides.push(candidate.partner.name);
          verdict = "reject";
        }
        if (safety.explanation) risks.unshift(safety.explanation);
      }

      if (candidate.relationship?.optedOut && verdict !== "reject") {
        overrides.push(candidate.partner.name);
        verdict = "reject";
        risks.unshift(
          `${candidate.partner.name} has opted out of outreach and must not be contacted.`,
        );
      }

      await tx.partnerRecommendation.create({
        data: {
          campaignId: input.campaignId,
          partnerId: item.partnerId,
          rank: item.rank,
          fitScore: item.fitScore,
          recommendation: verdict,
          reasons: item.reasons,
          risks,
          memoryUsed: item.memoryUsed,
          rawMindResponseReference: input.exchangeId,
        },
      });
    }
  });

  const top = [...input.response.recommendations]
    .filter((item) => {
      const candidate = byId.get(item.partnerId);
      if (!candidate) return false;
      return !assessPartnerSafety(input.creator.prohibitedTopics, candidate.partner).blocked;
    })
    .sort((a, b) => a.rank - b.rank)[0];

  return {
    overrides: [...new Set(overrides)],
    topPartnerName: top ? (byId.get(top.partnerId)?.partner.name ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// Human control gates
// ---------------------------------------------------------------------------

/** True when the creator explicitly rejected this partner for this campaign. */
export async function isPartnerRejectedForCampaign(
  campaignId: string,
  partnerId: string,
): Promise<boolean> {
  const rejections = await prisma.approval.findMany({
    where: {
      campaignId,
      actionType: ApprovalActionType.partner_selection,
      status: ApprovalStatus.rejected,
    },
    select: { payload: true },
  });

  return rejections.some((row) => {
    const payload = row.payload as { partnerId?: unknown } | null;
    return payload?.partnerId === partnerId;
  });
}

/**
 * Records the creator's partner choice and immediately raises the next human gate.
 *
 * Approving a partner does NOT authorise contacting them — that is a separate approval
 * (§18: "first external outreach" requires its own sign-off), so this transitions
 * straight through to `outreach_approval_required` and creates a pending approval.
 */
export async function approvePartner(input: {
  campaignId: string;
  partnerId: string;
}): Promise<{ ok: true }> {
  const [campaign, partner] = await Promise.all([
    prisma.campaign.findUnique({
      where: { id: input.campaignId },
      include: { creator: true },
    }),
    prisma.partner.findUnique({ where: { id: input.partnerId } }),
  ]);

  if (!campaign) throw new Error(`Campaign ${input.campaignId} not found.`);
  if (!partner) throw new Error(`Partner ${input.partnerId} not found.`);

  if (campaign.status !== CampaignStatus.partners_recommended) {
    throw new Error(
      `Cannot approve a partner while the campaign is in state "${campaign.status}".`,
    );
  }

  // Hard boundary — not overridable from the UI.
  const safety = assessPartnerSafety(campaign.creator.prohibitedTopics, partner);
  if (safety.blocked) {
    throw new BrandSafetyViolationError(partner.name, safety.conflicts);
  }

  const relationship = await prisma.relationship.findUnique({
    where: { creatorId_partnerId: { creatorId: campaign.creatorId, partnerId: partner.id } },
  });
  if (relationship?.optedOut) {
    throw new PartnerContactBlockedError(partner.name, "opted_out");
  }

  if (await isPartnerRejectedForCampaign(campaign.id, partner.id)) {
    throw new PartnerContactBlockedError(partner.name, "rejected");
  }

  const correlationId = newCorrelationId();
  const now = new Date();

  await prisma.approval.create({
    data: {
      campaignId: campaign.id,
      actionType: ApprovalActionType.partner_selection,
      payload: { partnerId: partner.id, partnerName: partner.name },
      status: ApprovalStatus.approved,
      requestedAt: now,
      approvedAt: now,
    },
  });

  await logApproval({
    campaignId: campaign.id,
    correlationId,
    actionType: "approval.partner_selection",
    summary: `Creator approved ${partner.name} as the collaboration partner`,
    decision: "approved",
    reason: `Human control gate: partner selection is never automatic.`,
  });

  await transitionCampaign({
    campaignId: campaign.id,
    to: CampaignStatus.partner_approved,
    actionType: "campaign.partner_approved",
    summary: `${partner.name} approved as partner`,
    correlationId,
    expectedFrom: [CampaignStatus.partners_recommended],
    // Prisma exposes the FK through the relation on update inputs.
    campaignData: { approvedPartner: { connect: { id: partner.id } } },
  });

  // Raise the next gate rather than proceeding to contact anyone.
  await prisma.approval.create({
    data: {
      campaignId: campaign.id,
      actionType: ApprovalActionType.first_outreach,
      payload: { partnerId: partner.id, partnerName: partner.name },
      status: ApprovalStatus.pending,
      requestedAt: now,
    },
  });

  await transitionCampaign({
    campaignId: campaign.id,
    to: CampaignStatus.outreach_approval_required,
    actionType: "campaign.outreach_approval_required",
    summary: `Awaiting creator approval before contacting ${partner.name}`,
    correlationId,
    expectedFrom: [CampaignStatus.partner_approved],
  });

  return { ok: true };
}

/** Records a rejection. The partner then cannot be approved for this campaign. */
export async function rejectPartner(input: {
  campaignId: string;
  partnerId: string;
  note?: string;
}): Promise<{ ok: true }> {
  const partner = await prisma.partner.findUnique({ where: { id: input.partnerId } });
  if (!partner) throw new Error(`Partner ${input.partnerId} not found.`);

  const now = new Date();
  const correlationId = newCorrelationId();

  await prisma.approval.create({
    data: {
      campaignId: input.campaignId,
      actionType: ApprovalActionType.partner_selection,
      payload: { partnerId: partner.id, partnerName: partner.name },
      status: ApprovalStatus.rejected,
      requestedAt: now,
      rejectedAt: now,
      decisionNote: input.note?.slice(0, 500) ?? null,
    },
  });

  await logApproval({
    campaignId: input.campaignId,
    correlationId,
    actionType: "approval.partner_rejected",
    summary: `Creator rejected ${partner.name}`,
    decision: "rejected",
    ...(input.note ? { reason: `Note: ${input.note.slice(0, 200)}` } : {}),
  });

  return { ok: true };
}

export async function cancelCampaign(input: {
  campaignId: string;
  reason?: string;
}): Promise<{ ok: true }> {
  await transitionCampaign({
    campaignId: input.campaignId,
    to: CampaignStatus.cancelled,
    actionType: "campaign.cancelled",
    summary: `Campaign cancelled by creator`,
    correlationId: newCorrelationId(),
    reason: input.reason,
    campaignData: { nextActionAt: null },
  });

  return { ok: true };
}

function truncate(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max - 1)}…`;
}

export { AgentActionStatus };
