/**
 * Integration: final approval → completion → relationship write-back.
 *
 * Covers from CLAUDE.md §20:
 *   • integration — deliverable submission to final approval
 *   • integration — campaign completion updates relationship history
 *
 * Also pins the honesty guarantees that matter most in this milestone: audience performance
 * is never invented, and completion never depends on the Mind being reachable.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FixedClock, resetClock, setClock } from "../../src/lib/clock.ts";
import { prisma } from "../../src/lib/db.ts";
import {
  acceptCollaboration,
  approveAndSendOutreach,
  submitDeliverable,
} from "../../src/lib/campaign/collaboration.ts";
import { approveDeliverable, rejectDeliverable } from "../../src/lib/campaign/completion.ts";
import { approvePartner, submitObjective } from "../../src/lib/campaign/service.ts";
import { CampaignStatus } from "../../src/lib/campaign/states.ts";
import { MindsNotConfiguredError } from "../../src/lib/minds/errors.ts";
import { resetCampaignState, seedDemoScenario } from "../../src/lib/seed/demo-seed.ts";
import { runFollowUpPass } from "../../src/worker/follow-up.ts";
import { RecordingTransport } from "../helpers/fake-transport.ts";
import {
  ScriptedMindsPort,
  buildBriefReply,
  buildFollowUpReply,
  buildOutreachReply,
  buildRankingReply,
} from "../helpers/scripted-port.ts";

const OBJECTIVE =
  "Launch a wallet-safety educational video and grow my beginner audience through one collaboration.";
const DEADLINE_SECONDS = Number(process.env.FOLLOW_UP_DELAY_SECONDS ?? 180);

const DEBRIEF_REPLY = JSON.stringify({
  whatWorked: [
    "Mira's beginner-focused framing matched the wallet-safety brief closely",
    "The deliverable arrived without needing to be chased",
  ],
  whatToImprove: ["Agree the revision window up front next time"],
  futurePartnerGuidance:
    "Mira remains the strongest first choice for beginner safety education; prefer her over " +
    "larger but less aligned commentary audiences.",
  memoryUsed: ["Completed one previous collaboration on time"],
});

let ids: { mira: string; alex: string; nova: string };
let clock: FixedClock;

beforeAll(async () => {
  const seeded = await seedDemoScenario(prisma);
  ids = seeded.partnerIds;
});

beforeEach(async () => {
  await resetCampaignState(prisma);
  // Reset Mira's relationship to the seeded baseline so before/after assertions are exact.
  await seedDemoScenario(prisma);
  clock = new FixedClock(new Date("2026-06-01T09:00:00.000Z"));
  setClock(clock);
});

afterEach(() => {
  resetClock();
});

afterAll(async () => {
  await resetCampaignState(prisma);
  await seedDemoScenario(prisma);
  await prisma.$disconnect();
});

/** Drives a campaign to `final_approval_required`, submitting on time by default. */
async function upToFinalApproval(options?: { late?: boolean; withFollowUp?: boolean }) {
  const { campaignId } = await submitObjective({
    objective: OBJECTIVE,
    port: new ScriptedMindsPort({ replies: [buildRankingReply(ids)] }),
  });
  await approvePartner({ campaignId, partnerId: ids.mira });
  await approveAndSendOutreach({
    campaignId,
    port: new ScriptedMindsPort({ replies: [buildOutreachReply()] }),
    transport: new RecordingTransport(),
  });
  await acceptCollaboration({
    campaignId,
    port: new ScriptedMindsPort({ replies: [buildBriefReply()] }),
  });

  if (options?.withFollowUp) {
    clock.advanceSeconds(DEADLINE_SECONDS + 1);
    await runFollowUpPass({
      clock,
      transport: new RecordingTransport(),
      port: new ScriptedMindsPort({ replies: [buildFollowUpReply()] }),
    });
  } else if (options?.late) {
    clock.advanceSeconds(DEADLINE_SECONDS + 3600);
  }

  await submitDeliverable({
    campaignId,
    submissionUrl: "https://example.com/mira-segment",
    note: "Ready for review.",
  });

  return campaignId;
}

describe("final approval completes the campaign", () => {
  it("moves to completed and approves the deliverable", async () => {
    const campaignId = await upToFinalApproval();

    const result = await approveDeliverable({
      campaignId,
      port: new ScriptedMindsPort({ replies: [DEBRIEF_REPLY] }),
    });

    expect(result.ok).toBe(true);
    expect(result.reached).toBe(CampaignStatus.completed);

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe(CampaignStatus.completed);
    expect(campaign.nextActionAt).toBeNull();

    const deliverable = await prisma.deliverable.findFirstOrThrow({ where: { campaignId } });
    expect(deliverable.status).toBe("approved");
    expect(deliverable.approvedAt).not.toBeNull();
  });

  it("records the final approval as a human gate", async () => {
    const campaignId = await upToFinalApproval();
    await approveDeliverable({
      campaignId,
      port: new ScriptedMindsPort({ replies: [DEBRIEF_REPLY] }),
    });

    const approval = await prisma.approval.findFirstOrThrow({
      where: { campaignId, actionType: "final_deliverable" },
    });
    expect(approval.status).toBe("approved");

    const action = await prisma.agentAction.findFirstOrThrow({
      where: { campaignId, actionType: "approval.final_deliverable" },
    });
    expect(action.requiresApproval).toBe(true);
    expect(action.approvedAt).not.toBeNull();
  });

  it("is idempotent", async () => {
    const campaignId = await upToFinalApproval();

    await approveDeliverable({
      campaignId,
      port: new ScriptedMindsPort({ replies: [DEBRIEF_REPLY] }),
    });

    // No scripted replies left: a second run must not talk to the Mind again.
    const second = await approveDeliverable({
      campaignId,
      port: new ScriptedMindsPort({ replies: [] }),
    });

    expect(second.steps).toContain("campaign already completed");
    expect(await prisma.campaignOutcome.count({ where: { campaignId } })).toBe(1);
  });

  it("refuses to complete from the wrong state", async () => {
    const { campaignId } = await submitObjective({
      objective: OBJECTIVE,
      port: new ScriptedMindsPort({ replies: [buildRankingReply(ids)] }),
    });

    await expect(
      approveDeliverable({ campaignId, port: new ScriptedMindsPort({ replies: [] }) }),
    ).rejects.toThrow(/Cannot approve the deliverable/);
  });
});

describe("audit log invariants", () => {
  it("never records more successes than attempts", async () => {
    // Regression guard. Human approvals were briefly routed through the execution
    // lifecycle, which set `executedAt` on rows whose `attemptedAt` was null and made the
    // report claim more successes than attempts. An approval is a decision, not an
    // execution, so the two lifecycles must stay separate.
    const campaignId = await upToFinalApproval({ withFollowUp: true });
    await approveDeliverable({
      campaignId,
      port: new ScriptedMindsPort({ replies: [DEBRIEF_REPLY] }),
    });

    const actions = await prisma.agentAction.findMany({ where: { campaignId } });

    const attempted = actions.filter((a) => a.attemptedAt !== null).length;
    const succeeded = actions.filter((a) => a.executedAt !== null).length;

    expect(succeeded).toBeLessThanOrEqual(attempted);
  });

  it("never marks an action as executed without also marking it attempted", async () => {
    const campaignId = await upToFinalApproval();
    await approveDeliverable({
      campaignId,
      port: new ScriptedMindsPort({ replies: [DEBRIEF_REPLY] }),
    });

    const incoherent = await prisma.agentAction.findMany({
      where: { campaignId, executedAt: { not: null }, attemptedAt: null },
    });

    expect(incoherent).toEqual([]);
  });

  it("records human approvals as decisions, not executions", async () => {
    const campaignId = await upToFinalApproval();
    await approveDeliverable({
      campaignId,
      port: new ScriptedMindsPort({ replies: [DEBRIEF_REPLY] }),
    });

    const approvals = await prisma.agentAction.findMany({
      where: { campaignId, actionType: { startsWith: "approval." } },
    });

    expect(approvals.length).toBeGreaterThanOrEqual(3); // partner, outreach, deliverable

    for (const approval of approvals) {
      expect(approval.requiresApproval).toBe(true);
      expect(approval.proposedAt).not.toBeNull();
      // A decision has no execution timestamps.
      expect(approval.attemptedAt).toBeNull();
      expect(approval.executedAt).toBeNull();
      expect(approval.status === "approved" || approval.status === "rejected").toBe(true);
    }
  });
});

describe("relationship history is updated", () => {
  it("increments collaborations and improves reliability for a clean delivery", async () => {
    const before = await prisma.relationship.findUniqueOrThrow({
      where: { creatorId_partnerId: { creatorId: "creator_maya", partnerId: ids.mira } },
    });
    expect(before.collaborationCount).toBe(1);
    expect(before.reliabilityScore).toBe(0.95);

    const campaignId = await upToFinalApproval();
    await approveDeliverable({
      campaignId,
      port: new ScriptedMindsPort({ replies: [DEBRIEF_REPLY] }),
    });

    const after = await prisma.relationship.findUniqueOrThrow({
      where: { creatorId_partnerId: { creatorId: "creator_maya", partnerId: ids.mira } },
    });

    expect(after.collaborationCount).toBe(2);
    expect(after.status).toBe("collaborated");
    // On time, no reminder needed: 0.95*0.6 + 1.0*0.4 = 0.97
    expect(after.reliabilityScore).toBe(0.97);
    expect(after.previousResponse).toMatch(/without needing a reminder/i);
    expect(after.lastContactedAt).not.toBeNull();
  });

  it("lowers reliability when a reminder was needed", async () => {
    const campaignId = await upToFinalApproval({ withFollowUp: true });
    await approveDeliverable({
      campaignId,
      port: new ScriptedMindsPort({ replies: [DEBRIEF_REPLY] }),
    });

    const after = await prisma.relationship.findUniqueOrThrow({
      where: { creatorId_partnerId: { creatorId: "creator_maya", partnerId: ids.mira } },
    });

    // Submitted after the deadline AND needed a reminder: 0.95*0.6 + 0.45*0.4 = 0.75
    expect(after.reliabilityScore).toBe(0.75);
    expect(after.reliabilityScore).toBeLessThan(0.95);
    expect(after.previousResponse).toMatch(/late/i);
  });

  it("audits the relationship update with the before and after values", async () => {
    const campaignId = await upToFinalApproval();
    await approveDeliverable({
      campaignId,
      port: new ScriptedMindsPort({ replies: [DEBRIEF_REPLY] }),
    });

    const action = await prisma.agentAction.findFirstOrThrow({
      where: { campaignId, actionType: "relationship.updated" },
    });
    expect(action.summary).toContain("0.95");
    expect(action.summary).toContain("0.97");
    expect(action.reason).toMatch(/on time = true/);
  });

  it("stores the observed outcome facts", async () => {
    const campaignId = await upToFinalApproval();
    await approveDeliverable({
      campaignId,
      port: new ScriptedMindsPort({ replies: [DEBRIEF_REPLY] }),
    });

    const outcome = await prisma.campaignOutcome.findUniqueOrThrow({ where: { campaignId } });
    expect(outcome.submittedOnTime).toBe(true);
    expect(outcome.neededFollowUp).toBe(false);
    expect(outcome.hoursLate).toBeNull();
    expect(outcome.reliabilityBefore).toBe(0.95);
    expect(outcome.reliabilityAfter).toBe(0.97);
  });

  it("records hours late when the deliverable missed its deadline", async () => {
    const campaignId = await upToFinalApproval({ late: true });
    await approveDeliverable({
      campaignId,
      port: new ScriptedMindsPort({ replies: [DEBRIEF_REPLY] }),
    });

    const outcome = await prisma.campaignOutcome.findUniqueOrThrow({ where: { campaignId } });
    expect(outcome.submittedOnTime).toBe(false);
    expect(outcome.hoursLate).toBeGreaterThan(0.9);
  });
});

describe("audience performance is never fabricated", () => {
  it("leaves performanceScore untouched when the creator reports nothing", async () => {
    const before = await prisma.relationship.findUniqueOrThrow({
      where: { creatorId_partnerId: { creatorId: "creator_maya", partnerId: ids.mira } },
    });

    const campaignId = await upToFinalApproval();
    await approveDeliverable({
      campaignId,
      port: new ScriptedMindsPort({ replies: [DEBRIEF_REPLY] }),
    });

    const after = await prisma.relationship.findUniqueOrThrow({
      where: { creatorId_partnerId: { creatorId: "creator_maya", partnerId: ids.mira } },
    });

    // CollabOS has no analytics, so it must not invent or adjust this number.
    expect(after.performanceScore).toBe(before.performanceScore);

    const outcome = await prisma.campaignOutcome.findUniqueOrThrow({ where: { campaignId } });
    expect(outcome.creatorReportedPerformance).toBeNull();
  });

  it("records a creator-reported figure when one is supplied", async () => {
    const campaignId = await upToFinalApproval();
    await approveDeliverable({
      campaignId,
      creatorReportedPerformance: 0.9,
      port: new ScriptedMindsPort({ replies: [DEBRIEF_REPLY] }),
    });

    const after = await prisma.relationship.findUniqueOrThrow({
      where: { creatorId_partnerId: { creatorId: "creator_maya", partnerId: ids.mira } },
    });
    expect(after.performanceScore).toBe(0.9);

    const outcome = await prisma.campaignOutcome.findUniqueOrThrow({ where: { campaignId } });
    expect(outcome.creatorReportedPerformance).toBe(0.9);
  });

  it("notes the absence of analytics in the audit reason", async () => {
    const campaignId = await upToFinalApproval();
    await approveDeliverable({
      campaignId,
      port: new ScriptedMindsPort({ replies: [DEBRIEF_REPLY] }),
    });

    const action = await prisma.agentAction.findFirstOrThrow({
      where: { campaignId, actionType: "relationship.updated" },
    });
    expect(action.reason).toMatch(/no analytics integration/i);
  });
});

describe("completion does not depend on the Mind", () => {
  it("completes and updates memory even when the debrief fails", async () => {
    const campaignId = await upToFinalApproval();

    const result = await approveDeliverable({
      campaignId,
      port: new ScriptedMindsPort({
        replies: [new MindsNotConfiguredError(["MINDS_BUILDER_API_KEY"])],
      }),
    });

    // The campaign genuinely completed.
    expect(result.ok).toBe(true);
    expect(result.debriefRecorded).toBe(false);
    expect(result.relationshipUpdated).toBe(true);

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe(CampaignStatus.completed);

    const after = await prisma.relationship.findUniqueOrThrow({
      where: { creatorId_partnerId: { creatorId: "creator_maya", partnerId: ids.mira } },
    });
    expect(after.collaborationCount).toBe(2);
  });

  it("records the debrief failure and invents no guidance", async () => {
    const campaignId = await upToFinalApproval();

    await approveDeliverable({
      campaignId,
      port: new ScriptedMindsPort({
        replies: [new MindsNotConfiguredError(["MINDS_BUILDER_API_KEY"])],
      }),
    });

    const action = await prisma.agentAction.findFirstOrThrow({
      where: { campaignId, actionType: "mind.campaign_debrief" },
    });
    expect(action.status).toBe("failed");
    expect(action.attemptedAt).not.toBeNull();
    expect(action.executedAt).toBeNull();

    // Observed facts stored; Mind-authored fields left empty rather than filled in.
    const outcome = await prisma.campaignOutcome.findUniqueOrThrow({ where: { campaignId } });
    expect(outcome.submittedOnTime).toBe(true);
    expect(outcome.whatWorked).toEqual([]);
    expect(outcome.futurePartnerGuidance).toBeNull();
  });

  it("stores the Mind's guidance when the debrief succeeds", async () => {
    const campaignId = await upToFinalApproval();
    await approveDeliverable({
      campaignId,
      port: new ScriptedMindsPort({ replies: [DEBRIEF_REPLY] }),
    });

    const outcome = await prisma.campaignOutcome.findUniqueOrThrow({ where: { campaignId } });
    expect(outcome.whatWorked.length).toBeGreaterThan(0);
    expect(outcome.futurePartnerGuidance).toMatch(/Mira/);
    expect(outcome.debriefExchangeReference).toBeTruthy();
  });
});

describe("revision round", () => {
  it("returns to awaiting_deliverable and reopens submission", async () => {
    const campaignId = await upToFinalApproval();

    const result = await rejectDeliverable({
      campaignId,
      note: "Please re-record the seed-phrase section.",
    });

    expect(result.reached).toBe(CampaignStatus.awaiting_deliverable);

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe(CampaignStatus.awaiting_deliverable);

    const deliverable = await prisma.deliverable.findFirstOrThrow({ where: { campaignId } });
    expect(deliverable.status).toBe("awaiting_submission");
    expect(deliverable.submittedAt).toBeNull();

    const approval = await prisma.approval.findFirstOrThrow({
      where: { campaignId, actionType: "final_deliverable" },
    });
    expect(approval.status).toBe("rejected");
    expect(approval.decisionNote).toMatch(/seed-phrase/);
  });

  it("does not allow a second autonomous follow-up after a revision", async () => {
    // Ties M5 and M6 together: the one-follow-up cap lives on followUpCount, so it survives
    // the campaign re-entering awaiting_deliverable.
    const campaignId = await upToFinalApproval({ withFollowUp: true });

    const campaignBefore = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaignBefore.followUpCount).toBe(1);

    await rejectDeliverable({ campaignId, note: "Needs a clearer intro." });

    // Force the campaign to look due again and run the worker.
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { nextActionAt: clock.now() },
    });
    clock.advanceSeconds(DEADLINE_SECONDS + 1);

    const transport = new RecordingTransport();
    const pass = await runFollowUpPass({
      clock,
      transport,
      port: new ScriptedMindsPort({ replies: [buildFollowUpReply()] }),
    });

    expect(pass.results[0]?.outcome).toBe("skipped_already_followed_up");
    expect(transport.sent).toHaveLength(0);
  });

  it("allows completion after a successful resubmission", async () => {
    const campaignId = await upToFinalApproval();
    await rejectDeliverable({ campaignId, note: "One more pass please." });

    await submitDeliverable({
      campaignId,
      submissionUrl: "https://example.com/mira-segment-v2",
    });

    const result = await approveDeliverable({
      campaignId,
      port: new ScriptedMindsPort({ replies: [DEBRIEF_REPLY] }),
    });

    expect(result.reached).toBe(CampaignStatus.completed);

    const after = await prisma.relationship.findUniqueOrThrow({
      where: { creatorId_partnerId: { creatorId: "creator_maya", partnerId: ids.mira } },
    });
    // One campaign, one increment — the revision round must not double-count.
    expect(after.collaborationCount).toBe(2);
  });
});
