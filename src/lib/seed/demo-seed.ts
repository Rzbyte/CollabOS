/**
 * The seeded demo scenario from CLAUDE.md §4.
 *
 * Extracted from `prisma/seed.ts` so the same data can be used by the CLI seed command,
 * the demo reset script, and the integration tests. A test that seeds differently from
 * the demo would be testing something the demo never does.
 *
 * Everything here is SYNTHETIC. All partners carry `isSynthetic: true` and use
 * `@example.com` — an IANA-reserved domain that cannot receive mail — so no seeded record
 * can result in contact with a real person.
 *
 * The numbers are arranged deliberately: Mira has the SMALLEST audience and the
 * STRONGEST history; Nova has the largest audience and a disqualifying safety flag. A
 * system ranking on reach alone would get this exactly backwards, which is what makes the
 * Mind's reasoning observable rather than merely asserted.
 */
import type { PrismaClient } from "../db.ts";

export const SEED_IDS = {
  creator: "creator_maya",
  mira: "partner_mira",
  alex: "partner_alex",
  nova: "partner_nova",
} as const;

export const MAYA_CONVERSATION_ALIAS = "collabos-maya";

export interface SeedResult {
  creatorId: string;
  partnerIds: { mira: string; alex: string; nova: string };
}

export async function seedDemoScenario(prisma: PrismaClient): Promise<SeedResult> {
  const now = new Date();
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

  // ------------------------------------------------------------------ creator
  const maya = await prisma.creatorProfile.upsert({
    where: { id: SEED_IDS.creator },
    create: {
      id: SEED_IDS.creator,
      name: "Maya",
      niche: "Web3 safety education",
      targetAudience: "Beginner crypto users taking their first self-custody steps",
      brandVoice: "Calm, practical, evidence-based, non-hype",
      prohibitedTopics: ["gambling", "leverage trading", "token shilling"],
      mindConversationAlias: MAYA_CONVERSATION_ALIAS,
    },
    update: {
      name: "Maya",
      niche: "Web3 safety education",
      targetAudience: "Beginner crypto users taking their first self-custody steps",
      brandVoice: "Calm, practical, evidence-based, non-hype",
      prohibitedTopics: ["gambling", "leverage trading", "token shilling"],
      mindConversationAlias: MAYA_CONVERSATION_ALIAS,
    },
  });

  // ----------------------------------------------------------------- partners
  const mira = await prisma.partner.upsert({
    where: { id: SEED_IDS.mira },
    create: {
      id: SEED_IDS.mira,
      name: "Mira Chen",
      email: "mira.chen@example.com",
      niche: "Beginner-friendly Web3 tutorials",
      audienceDescription:
        "Newcomers following step-by-step wallet and self-custody walkthroughs; " +
        "high completion rate on educational series",
      collaborationPreferences:
        "Concise and practical communication. Prefers a clear brief, one revision " +
        "round, and firm deadlines.",
      audienceSize: 48_000,
      reliabilityScore: 0.95,
      safetyFlags: [],
      isSynthetic: true,
    },
    update: { audienceSize: 48_000, reliabilityScore: 0.95, safetyFlags: [] },
  });

  const alex = await prisma.partner.upsert({
    where: { id: SEED_IDS.alex },
    create: {
      id: SEED_IDS.alex,
      name: "Alex Morgan",
      email: "alex.morgan@example.com",
      niche: "Crypto market commentary",
      audienceDescription:
        "Active traders following daily market takes; largely past the beginner stage " +
        "and less aligned with introductory safety education",
      collaborationPreferences:
        "Responsive but frequently over-committed. Needs long scheduling lead time.",
      audienceSize: 210_000,
      reliabilityScore: 0.55,
      safetyFlags: [],
      isSynthetic: true,
    },
    update: { audienceSize: 210_000, reliabilityScore: 0.55, safetyFlags: [] },
  });

  const nova = await prisma.partner.upsert({
    where: { id: SEED_IDS.nova },
    create: {
      id: SEED_IDS.nova,
      name: "Nova Alpha",
      email: "nova.alpha@example.com",
      niche: "High-risk trading calls",
      audienceDescription:
        "Large following seeking leveraged trade signals and short-term calls",
      collaborationPreferences: "Wants revenue-share promotion of leveraged products.",
      audienceSize: 540_000,
      reliabilityScore: 0.4,
      // Collides with Maya's prohibited topics — a hard block enforced by CollabOS.
      safetyFlags: ["leverage_trading", "high_risk_trading_calls", "token_shilling"],
      isSynthetic: true,
    },
    update: {
      audienceSize: 540_000,
      reliabilityScore: 0.4,
      safetyFlags: ["leverage_trading", "high_risk_trading_calls", "token_shilling"],
    },
  });

  // -------------------------------------------------------- relationship memory
  await prisma.relationship.upsert({
    where: { creatorId_partnerId: { creatorId: maya.id, partnerId: mira.id } },
    create: {
      creatorId: maya.id,
      partnerId: mira.id,
      status: "collaborated",
      previousResponse:
        "Accepted the previous collaboration and delivered the agreed video on time.",
      collaborationCount: 1,
      performanceScore: 0.82,
      reliabilityScore: 0.95,
      preferredCommunicationStyle: "Concise and practical",
      lastContactedAt: daysAgo(94),
      optedOut: false,
    },
    update: {
      status: "collaborated",
      previousResponse:
        "Accepted the previous collaboration and delivered the agreed video on time.",
      rejectionReason: null,
      collaborationCount: 1,
      performanceScore: 0.82,
      reliabilityScore: 0.95,
      preferredCommunicationStyle: "Concise and practical",
      lastContactedAt: daysAgo(94),
      optedOut: false,
    },
  });

  await prisma.relationship.upsert({
    where: { creatorId_partnerId: { creatorId: maya.id, partnerId: alex.id } },
    create: {
      creatorId: maya.id,
      partnerId: alex.id,
      status: "declined",
      previousResponse: "Declined the last collaboration invitation.",
      rejectionReason: "Scheduling conflict during the requested launch window.",
      collaborationCount: 0,
      reliabilityScore: 0.55,
      preferredCommunicationStyle: "Direct, but needs long lead time",
      lastContactedAt: daysAgo(151),
      // Declined once for scheduling reasons is NOT an opt-out; re-approaching is allowed.
      optedOut: false,
    },
    update: {
      status: "declined",
      previousResponse: "Declined the last collaboration invitation.",
      rejectionReason: "Scheduling conflict during the requested launch window.",
      collaborationCount: 0,
      performanceScore: null,
      reliabilityScore: 0.55,
      preferredCommunicationStyle: "Direct, but needs long lead time",
      lastContactedAt: daysAgo(151),
      optedOut: false,
    },
  });

  // Nova intentionally has NO relationship row: never contacted, no history. The only
  // basis for a verdict is the brand-safety conflict.
  await prisma.relationship.deleteMany({
    where: { creatorId: maya.id, partnerId: nova.id },
  });

  return {
    creatorId: maya.id,
    partnerIds: { mira: mira.id, alex: alex.id, nova: nova.id },
  };
}

/**
 * Clears all campaign-scoped state while preserving creator, partners, and relationship
 * memory.
 *
 * Used by `npm run demo:reset` and between integration tests. Relationship history is
 * deliberately NOT cleared here — `db:reset` exists for a full wipe.
 */
export async function resetCampaignState(prisma: PrismaClient): Promise<void> {
  // Ordered to respect foreign keys, though most cascade from Campaign.
  await prisma.agentAction.deleteMany({});
  await prisma.mindExchange.deleteMany({});
  await prisma.outboundMessage.deleteMany({});
  await prisma.circleMembership.deleteMany({});
  await prisma.partnerRecommendation.deleteMany({});
  await prisma.approval.deleteMany({});
  await prisma.deliverable.deleteMany({});
  await prisma.campaignBrief.deleteMany({});
  await prisma.campaign.deleteMany({});
}
