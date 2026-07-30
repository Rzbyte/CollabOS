/**
 * Integration: seeded objective → validated recommendations → partner approval.
 *
 * Runs against the REAL Postgres started by `npm run infra:up` with the real Prisma
 * client, real state machine, and real audit log. Only the Mind is scripted, so these
 * tests assert CollabOS's behaviour rather than a model's wording.
 *
 * Covers from CLAUDE.md §20:
 *   • integration — seeded objective to partner recommendations
 *   • integration — failed external action does not produce a false success state
 *   • unit — rejected partner cannot be contacted
 *   • unit — brand-safety candidate is rejected or flagged
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../../src/lib/db.ts";
import { CampaignStatus } from "../../src/lib/campaign/states.ts";
import {
  ActiveCampaignExistsError,
  approvePartner,
  rejectPartner,
  retryRecommendations,
  submitObjective,
} from "../../src/lib/campaign/service.ts";
import { MindsNotConfiguredError } from "../../src/lib/minds/errors.ts";
import {
  BrandSafetyViolationError,
  PartnerContactBlockedError,
} from "../../src/lib/safety/brand-safety.ts";
import { resetCampaignState, seedDemoScenario } from "../../src/lib/seed/demo-seed.ts";
import {
  ScriptedMindsPort,
  buildRankingReply,
  buildUnsafeRankingReply,
} from "../helpers/scripted-port.ts";

const OBJECTIVE =
  "Launch a wallet-safety educational video and grow my beginner audience through one collaboration.";

let ids: { mira: string; alex: string; nova: string };

beforeAll(async () => {
  const seeded = await seedDemoScenario(prisma);
  ids = seeded.partnerIds;
});

beforeEach(async () => {
  // Fresh campaign state per test; creator, partners, and relationship memory persist.
  await resetCampaignState(prisma);
});

afterAll(async () => {
  await resetCampaignState(prisma);
  await prisma.$disconnect();
});

describe("submitObjective — seeded objective to recommendations", () => {
  it("produces validated recommendations and advances the campaign", async () => {
    const port = new ScriptedMindsPort({ replies: [buildRankingReply(ids)] });

    const result = await submitObjective({ objective: OBJECTIVE, port });

    expect(result.recommended).toBe(true);
    expect(result.error).toBeUndefined();

    const campaign = await prisma.campaign.findUniqueOrThrow({
      where: { id: result.campaignId },
    });
    expect(campaign.status).toBe(CampaignStatus.partners_recommended);
    expect(campaign.objective).toBe(OBJECTIVE);
  });

  it("ranks Mira first over the two larger audiences", async () => {
    const port = new ScriptedMindsPort({ replies: [buildRankingReply(ids)] });
    const result = await submitObjective({ objective: OBJECTIVE, port });

    const recommendations = await prisma.partnerRecommendation.findMany({
      where: { campaignId: result.campaignId },
      include: { partner: true },
      orderBy: { rank: "asc" },
    });

    expect(recommendations).toHaveLength(3);

    const top = recommendations[0];
    expect(top?.partner.name).toBe("Mira Chen");
    expect(top?.recommendation).toBe("recommended");

    // The point of the scenario: the winner has the smallest audience.
    const audiences = recommendations.map((r) => r.partner.audienceSize);
    expect(top?.partner.audienceSize).toBe(Math.min(...audiences));
  });

  it("persists the memory the Mind said it used", async () => {
    const port = new ScriptedMindsPort({ replies: [buildRankingReply(ids)] });
    const result = await submitObjective({ objective: OBJECTIVE, port });

    const mira = await prisma.partnerRecommendation.findFirstOrThrow({
      where: { campaignId: result.campaignId, partnerId: ids.mira },
    });

    expect(mira.memoryUsed.length).toBeGreaterThan(0);
    expect(mira.memoryUsed.join(" ")).toMatch(/on time/i);
    expect(mira.reasons.length).toBeGreaterThan(0);
  });

  it("treats Alex cautiously and cites the previous decline", async () => {
    const port = new ScriptedMindsPort({ replies: [buildRankingReply(ids)] });
    const result = await submitObjective({ objective: OBJECTIVE, port });

    const alex = await prisma.partnerRecommendation.findFirstOrThrow({
      where: { campaignId: result.campaignId, partnerId: ids.alex },
    });

    expect(alex.recommendation).toBe("consider");
    expect(alex.risks.join(" ")).toMatch(/scheduling/i);
  });

  it("rejects Nova on brand safety", async () => {
    const port = new ScriptedMindsPort({ replies: [buildRankingReply(ids)] });
    const result = await submitObjective({ objective: OBJECTIVE, port });

    const nova = await prisma.partnerRecommendation.findFirstOrThrow({
      where: { campaignId: result.campaignId, partnerId: ids.nova },
    });

    expect(nova.recommendation).toBe("reject");
  });

  it("sends the creator's brand memory to the Mind in the prompt", async () => {
    const port = new ScriptedMindsPort({ replies: [buildRankingReply(ids)] });
    await submitObjective({ objective: OBJECTIVE, port });

    const prompt = port.prompts[0] ?? "";

    // Brand constraints and relationship history must actually reach the Mind — this is
    // the difference between "memory exists" and "memory informs the decision".
    expect(prompt).toContain("leverage trading");
    expect(prompt).toContain("Calm, practical, evidence-based, non-hype");
    expect(prompt).toContain("Scheduling conflict");
    expect(prompt).toContain(ids.mira);
  });

  it("reuses the creator's durable conversation alias", async () => {
    const port = new ScriptedMindsPort({ replies: [buildRankingReply(ids)] });
    await submitObjective({ objective: OBJECTIVE, port });

    expect(port.conversationsEnsured).toContain("collabos-maya");
  });

  it("records the loaded-memory and ranking steps in the audit log", async () => {
    const port = new ScriptedMindsPort({ replies: [buildRankingReply(ids)] });
    const result = await submitObjective({ objective: OBJECTIVE, port });

    const actions = await prisma.agentAction.findMany({
      where: { campaignId: result.campaignId },
    });
    const types = actions.map((a) => a.actionType);

    expect(types).toContain("memory.loaded");
    expect(types).toContain("mind.partner_ranking");
    expect(types).toContain("campaign.partners_recommended");

    const ranking = actions.find((a) => a.actionType === "mind.partner_ranking");
    expect(ranking?.status).toBe("succeeded");
    // A successful action records BOTH that it was attempted and that it completed.
    expect(ranking?.attemptedAt).not.toBeNull();
    expect(ranking?.executedAt).not.toBeNull();
    expect(ranking?.failedAt).toBeNull();
  });

  it("stores the raw Mind exchange and links recommendations to it", async () => {
    const port = new ScriptedMindsPort({ replies: [buildRankingReply(ids)] });
    const result = await submitObjective({ objective: OBJECTIVE, port });

    const exchanges = await prisma.mindExchange.findMany({
      where: { campaignId: result.campaignId },
    });
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.validated).toBe(true);
    expect(exchanges[0]?.alias).toBe("collabos-maya");

    const recommendation = await prisma.partnerRecommendation.findFirstOrThrow({
      where: { campaignId: result.campaignId },
    });
    expect(recommendation.rawMindResponseReference).toBe(exchanges[0]?.id);
  });

  it("refuses a second concurrent campaign", async () => {
    const port = new ScriptedMindsPort({
      replies: [buildRankingReply(ids), buildRankingReply(ids)],
    });

    await submitObjective({ objective: OBJECTIVE, port });

    await expect(submitObjective({ objective: OBJECTIVE, port })).rejects.toThrow(
      ActiveCampaignExistsError,
    );
  });

  it("rejects an objective that is too short to be meaningful", async () => {
    const port = new ScriptedMindsPort({ replies: [] });
    await expect(submitObjective({ objective: "grow", port })).rejects.toThrow(/10 characters/);
  });
});

describe("brand-safety override", () => {
  it("forces a reject verdict when the Mind wrongly recommends the unsafe partner", async () => {
    // The Mind ranks Nova #1 on audience size alone — exactly the mistake CollabOS must
    // not propagate to the creator.
    const port = new ScriptedMindsPort({ replies: [buildUnsafeRankingReply(ids)] });

    const result = await submitObjective({ objective: OBJECTIVE, port });

    expect(result.recommended).toBe(true);
    expect(result.overrides).toContain("Nova Alpha");

    const nova = await prisma.partnerRecommendation.findFirstOrThrow({
      where: { campaignId: result.campaignId, partnerId: ids.nova },
    });

    // Verdict overridden despite the Mind saying "recommended".
    expect(nova.recommendation).toBe("reject");
    expect(nova.risks.join(" ")).toMatch(/brand-safety/i);
  });

  it("records the override rather than applying it silently", async () => {
    const port = new ScriptedMindsPort({ replies: [buildUnsafeRankingReply(ids)] });
    const result = await submitObjective({ objective: OBJECTIVE, port });

    const override = await prisma.agentAction.findFirst({
      where: { campaignId: result.campaignId, actionType: "safety.override" },
    });

    expect(override).not.toBeNull();
    expect(override?.summary).toContain("Nova Alpha");
  });

  it("refuses to approve the blocked partner even when asked directly", async () => {
    const port = new ScriptedMindsPort({ replies: [buildUnsafeRankingReply(ids)] });
    const result = await submitObjective({ objective: OBJECTIVE, port });

    await expect(
      approvePartner({ campaignId: result.campaignId, partnerId: ids.nova }),
    ).rejects.toThrow(BrandSafetyViolationError);

    // The campaign must not have advanced.
    const campaign = await prisma.campaign.findUniqueOrThrow({
      where: { id: result.campaignId },
    });
    expect(campaign.status).toBe(CampaignStatus.partners_recommended);
    expect(campaign.approvedPartnerId).toBeNull();
  });
});

describe("approvePartner — human control gates", () => {
  async function seedRecommended() {
    const port = new ScriptedMindsPort({ replies: [buildRankingReply(ids)] });
    return submitObjective({ objective: OBJECTIVE, port });
  }

  it("records the approval and raises the separate outreach gate", async () => {
    const { campaignId } = await seedRecommended();

    await approvePartner({ campaignId, partnerId: ids.mira });

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });

    // Approving a partner must NOT authorise contacting them.
    expect(campaign.status).toBe(CampaignStatus.outreach_approval_required);
    expect(campaign.approvedPartnerId).toBe(ids.mira);

    const approvals = await prisma.approval.findMany({ where: { campaignId } });
    const selection = approvals.find((a) => a.actionType === "partner_selection");
    const outreach = approvals.find((a) => a.actionType === "first_outreach");

    expect(selection?.status).toBe("approved");
    expect(selection?.approvedAt).not.toBeNull();
    expect(outreach?.status).toBe("pending");
  });

  it("audits the approval as a human gate", async () => {
    const { campaignId } = await seedRecommended();
    await approvePartner({ campaignId, partnerId: ids.mira });

    const action = await prisma.agentAction.findFirstOrThrow({
      where: { campaignId, actionType: "approval.partner_selection" },
    });

    expect(action.requiresApproval).toBe(true);
    expect(action.summary).toContain("Mira Chen");
  });

  it("prevents contacting a partner the creator rejected", async () => {
    const { campaignId } = await seedRecommended();

    await rejectPartner({
      campaignId,
      partnerId: ids.mira,
      note: "Want to try someone new this quarter.",
    });

    await expect(approvePartner({ campaignId, partnerId: ids.mira })).rejects.toThrow(
      PartnerContactBlockedError,
    );
  });

  it("prevents contacting a partner who opted out", async () => {
    const { campaignId } = await seedRecommended();

    await prisma.relationship.update({
      where: {
        creatorId_partnerId: { creatorId: "creator_maya", partnerId: ids.alex },
      },
      data: { optedOut: true },
    });

    try {
      await expect(approvePartner({ campaignId, partnerId: ids.alex })).rejects.toThrow(
        PartnerContactBlockedError,
      );
    } finally {
      await prisma.relationship.update({
        where: {
          creatorId_partnerId: { creatorId: "creator_maya", partnerId: ids.alex },
        },
        data: { optedOut: false },
      });
    }
  });

  it("refuses a second approval once a partner is chosen", async () => {
    const { campaignId } = await seedRecommended();
    await approvePartner({ campaignId, partnerId: ids.mira });

    await expect(approvePartner({ campaignId, partnerId: ids.alex })).rejects.toThrow(
      /Cannot approve a partner while the campaign is in state/,
    );
  });
});

describe("failed Mind call does not produce a false success state", () => {
  it("leaves the campaign recoverable and records the failure", async () => {
    const port = new ScriptedMindsPort({
      replies: [new MindsNotConfiguredError(["MINDS_BUILDER_API_KEY"])],
    });

    const result = await submitObjective({ objective: OBJECTIVE, port });

    expect(result.recommended).toBe(false);
    expect(result.error?.code).toBe("MINDS_NOT_CONFIGURED");

    const campaign = await prisma.campaign.findUniqueOrThrow({
      where: { id: result.campaignId },
    });

    // Not `partners_recommended`, and not the near-terminal `failed` either: the
    // objective genuinely was submitted and the work is retryable.
    expect(campaign.status).toBe(CampaignStatus.objective_submitted);

    // Nothing was invented in place of a real ranking.
    const recommendations = await prisma.partnerRecommendation.findMany({
      where: { campaignId: result.campaignId },
    });
    expect(recommendations).toHaveLength(0);
  });

  it("keeps attempted and failed as distinct recorded facts", async () => {
    const port = new ScriptedMindsPort({
      replies: [new MindsNotConfiguredError(["MINDS_BUILDER_API_KEY"])],
    });
    const result = await submitObjective({ objective: OBJECTIVE, port });

    const action = await prisma.agentAction.findFirstOrThrow({
      where: { campaignId: result.campaignId, actionType: "mind.partner_ranking" },
    });

    expect(action.status).toBe("failed");
    expect(action.attemptedAt).not.toBeNull(); // we did try
    expect(action.executedAt).toBeNull(); // and it did not succeed
    expect(action.failedAt).not.toBeNull();
    expect(action.errorCode).toBe("MINDS_NOT_CONFIGURED");
  });

  it("never stores a secret in the failure message", async () => {
    const port = new ScriptedMindsPort({
      replies: [new Error("auth failed for key eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig")],
    });
    const result = await submitObjective({ objective: OBJECTIVE, port });

    const action = await prisma.agentAction.findFirstOrThrow({
      where: { campaignId: result.campaignId, actionType: "mind.partner_ranking" },
    });

    expect(action.sanitisedErrorMessage).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(action.sanitisedErrorMessage).toContain("[redacted");
  });

  it("recovers when the Mind works on retry", async () => {
    const failing = new ScriptedMindsPort({
      replies: [new MindsNotConfiguredError(["MINDS_BUILDER_API_KEY"])],
    });
    const result = await submitObjective({ objective: OBJECTIVE, port: failing });
    expect(result.recommended).toBe(false);

    const working = new ScriptedMindsPort({ replies: [buildRankingReply(ids)] });
    const retry = await retryRecommendations({
      campaignId: result.campaignId,
      port: working,
    });

    expect(retry.recommended).toBe(true);

    const campaign = await prisma.campaign.findUniqueOrThrow({
      where: { id: result.campaignId },
    });
    expect(campaign.status).toBe(CampaignStatus.partners_recommended);

    // Both the failure and the eventual success remain in the audit trail.
    const actions = await prisma.agentAction.findMany({
      where: { campaignId: result.campaignId, actionType: "mind.partner_ranking" },
    });
    expect(actions.some((a) => a.status === "failed")).toBe(true);
    expect(actions.some((a) => a.status === "succeeded")).toBe(true);
  });
});
