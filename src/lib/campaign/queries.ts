/**
 * Read models for the UI.
 *
 * Kept separate from `service.ts` so that mutations and queries do not blur together:
 * anything in here is side-effect free and safe to call from a server component render.
 */
import { ApprovalActionType, ApprovalStatus } from "../../generated/prisma/enums.ts";
import { toTimelineEvents, type TimelineEvent } from "../audit/log.ts";
import { prisma } from "../db.ts";
import { assessPartnerSafety, type SafetyAssessment } from "../safety/brand-safety.ts";
import { CampaignStatus } from "./states.ts";

const NON_TERMINAL = (Object.values(CampaignStatus) as CampaignStatus[]).filter(
  (status) =>
    status !== CampaignStatus.completed &&
    status !== CampaignStatus.cancelled &&
    status !== CampaignStatus.failed,
);

export async function getCreator() {
  return prisma.creatorProfile.findFirst({
    include: { relationships: { include: { partner: true } } },
  });
}

/** Most recent campaign, active if one exists, otherwise the latest finished one. */
export async function getCurrentCampaign() {
  const active = await prisma.campaign.findFirst({
    where: { status: { in: NON_TERMINAL } },
    orderBy: { createdAt: "desc" },
    include: {
      creator: true,
      approvedPartner: true,
      brief: true,
      deliverables: { orderBy: { createdAt: "asc" } },
      circleMembers: true,
      approvals: { orderBy: { requestedAt: "desc" } },
    },
  });

  if (active) return active;

  return prisma.campaign.findFirst({
    orderBy: { createdAt: "desc" },
    include: {
      creator: true,
      approvedPartner: true,
      brief: true,
      deliverables: { orderBy: { createdAt: "asc" } },
      circleMembers: true,
      approvals: { orderBy: { requestedAt: "desc" } },
    },
  });
}

export interface RecommendationView {
  id: string;
  rank: number;
  fitScore: number;
  recommendation: "recommended" | "consider" | "reject";
  reasons: string[];
  risks: string[];
  memoryUsed: string[];
  rawMindResponseReference: string | null;
  partner: {
    id: string;
    name: string;
    niche: string;
    audienceDescription: string;
    audienceSize: number;
    collaborationPreferences: string;
    safetyFlags: string[];
    isSynthetic: boolean;
  };
  relationship: {
    status: string;
    collaborationCount: number;
    previousResponse: string | null;
    rejectionReason: string | null;
    performanceScore: number | null;
    reliabilityScore: number | null;
    preferredCommunicationStyle: string | null;
    lastContactedAt: Date | null;
    optedOut: boolean;
  } | null;
  safety: SafetyAssessment;
  /** True when the creator already rejected this partner for this campaign. */
  rejectedByCreator: boolean;
}

/**
 * Partner Review data.
 *
 * Ordering puts brand-safety-blocked candidates last regardless of the rank the Mind
 * assigned, so a blocked partner can never appear at the top of the creator's list even
 * if the Mind ranked it first.
 */
export async function getRecommendations(campaignId: string): Promise<RecommendationView[]> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { creator: true },
  });
  if (!campaign) return [];

  const [rows, relationships, rejections] = await Promise.all([
    prisma.partnerRecommendation.findMany({
      where: { campaignId },
      include: { partner: true },
      orderBy: { rank: "asc" },
    }),
    prisma.relationship.findMany({ where: { creatorId: campaign.creatorId } }),
    prisma.approval.findMany({
      where: {
        campaignId,
        actionType: ApprovalActionType.partner_selection,
        status: ApprovalStatus.rejected,
      },
      select: { payload: true },
    }),
  ]);

  const relationshipByPartner = new Map(relationships.map((r) => [r.partnerId, r]));
  const rejectedIds = new Set(
    rejections
      .map((row) => (row.payload as { partnerId?: unknown } | null)?.partnerId)
      .filter((value): value is string => typeof value === "string"),
  );

  const views: RecommendationView[] = rows.map((row) => {
    const relationship = relationshipByPartner.get(row.partnerId) ?? null;

    return {
      id: row.id,
      rank: row.rank,
      fitScore: row.fitScore,
      recommendation: row.recommendation,
      reasons: row.reasons,
      risks: row.risks,
      memoryUsed: row.memoryUsed,
      rawMindResponseReference: row.rawMindResponseReference,
      partner: {
        id: row.partner.id,
        name: row.partner.name,
        niche: row.partner.niche,
        audienceDescription: row.partner.audienceDescription,
        audienceSize: row.partner.audienceSize,
        collaborationPreferences: row.partner.collaborationPreferences,
        safetyFlags: row.partner.safetyFlags,
        isSynthetic: row.partner.isSynthetic,
      },
      relationship: relationship
        ? {
            status: relationship.status,
            collaborationCount: relationship.collaborationCount,
            previousResponse: relationship.previousResponse,
            rejectionReason: relationship.rejectionReason,
            performanceScore: relationship.performanceScore,
            reliabilityScore: relationship.reliabilityScore,
            preferredCommunicationStyle: relationship.preferredCommunicationStyle,
            lastContactedAt: relationship.lastContactedAt,
            optedOut: relationship.optedOut,
          }
        : null,
      safety: assessPartnerSafety(campaign.creator.prohibitedTopics, row.partner),
      rejectedByCreator: rejectedIds.has(row.partnerId),
    };
  });

  return views.sort((a, b) => {
    if (a.safety.blocked !== b.safety.blocked) return a.safety.blocked ? 1 : -1;
    return a.rank - b.rank;
  });
}

export async function getPendingApprovals(campaignId: string) {
  return prisma.approval.findMany({
    where: { campaignId, status: ApprovalStatus.pending },
    orderBy: { requestedAt: "asc" },
  });
}

/** Chronological audit timeline. */
export async function getActivityLog(options?: {
  campaignId?: string;
  limit?: number;
}): Promise<TimelineEvent[]> {
  const actions = await prisma.agentAction.findMany({
    ...(options?.campaignId ? { where: { campaignId: options.campaignId } } : {}),
    orderBy: { createdAt: "desc" },
    take: options?.limit ?? 200,
  });

  // Fetched newest-first for the LIMIT, then projected and re-sorted ascending.
  return toTimelineEvents(actions);
}

export async function getMindExchanges(campaignId: string) {
  return prisma.mindExchange.findMany({
    where: { campaignId },
    orderBy: { createdAt: "asc" },
  });
}

export async function getOutboundMessages(campaignId: string) {
  return prisma.outboundMessage.findMany({
    where: { campaignId },
    orderBy: { createdAt: "asc" },
  });
}


/**
 * Most recently completed campaign, else the latest campaign of any kind.
 *
 * The report is most useful after completion, but showing an in-progress campaign is better
 * than an empty page.
 */
export async function getReportCampaign() {
  const include = {
    creator: true,
    approvedPartner: true,
    brief: true,
    outcome: true,
    deliverables: { orderBy: { createdAt: "asc" } },
    circleMembers: true,
    approvals: { orderBy: { requestedAt: "asc" } },
    messages: { orderBy: { createdAt: "asc" } },
    recommendations: { include: { partner: true }, orderBy: { rank: "asc" } },
  } as const;

  const completed = await prisma.campaign.findFirst({
    where: { status: CampaignStatus.completed },
    orderBy: { updatedAt: "desc" },
    include,
  });

  if (completed) return completed;

  return prisma.campaign.findFirst({ orderBy: { createdAt: "desc" }, include });
}

/** Current relationship rows for a creator, for the report's before/after view. */
export async function getRelationships(creatorId: string) {
  return prisma.relationship.findMany({
    where: { creatorId },
    include: { partner: true },
    orderBy: { partner: { name: "asc" } },
  });
}

/** Audit counts by lifecycle phase, for the report's execution summary. */
export async function getPhaseCounts(campaignId: string): Promise<{
  proposed: number;
  approved: number;
  attempted: number;
  succeeded: number;
  failed: number;
  autonomous: number;
  humanGates: number;
}> {
  const actions = await prisma.agentAction.findMany({ where: { campaignId } });

  return {
    proposed: actions.filter((a) => a.proposedAt !== null).length,
    approved: actions.filter((a) => a.approvedAt !== null).length,
    attempted: actions.filter((a) => a.attemptedAt !== null).length,
    succeeded: actions.filter((a) => a.executedAt !== null).length,
    failed: actions.filter((a) => a.failedAt !== null).length,
    autonomous: actions.filter((a) => a.autonomous).length,
    humanGates: actions.filter((a) => a.requiresApproval).length,
  };
}
