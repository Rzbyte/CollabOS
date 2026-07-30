/**
 * Integration: the autonomous follow-up worker.
 *
 * Covers from CLAUDE.md §20:
 *   • unit — maximum one autonomous follow-up
 *   • unit — idempotent worker execution
 *   • unit — rejected/opted-out partner cannot be contacted
 *   • integration — overdue deliverable to autonomous follow-up
 *   • integration — failed external action does not produce a false success state
 *
 * Time is driven entirely by an injected `FixedClock`, so the three-minute deadline is
 * proven by advancing a controlled clock rather than by waiting (§20: "do not make automated
 * tests wait three real minutes"). The whole file runs in a few seconds.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FixedClock, resetClock, setClock } from "../../src/lib/clock.ts";
import { prisma } from "../../src/lib/db.ts";
import {
  acceptCollaboration,
  approveAndSendOutreach,
  submitDeliverable,
} from "../../src/lib/campaign/collaboration.ts";
import { approvePartner, submitObjective } from "../../src/lib/campaign/service.ts";
import { CampaignStatus } from "../../src/lib/campaign/states.ts";
import { MindsReplyTimeoutError } from "../../src/lib/minds/errors.ts";
import { resetCampaignState, seedDemoScenario } from "../../src/lib/seed/demo-seed.ts";
import {
  MAX_FOLLOW_UP_ATTEMPTS,
  claimDueCampaigns,
  processClaimedCampaign,
  runFollowUpPass,
} from "../../src/worker/follow-up.ts";
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

/** FOLLOW_UP_DELAY_SECONDS default from .env. */
const DEADLINE_SECONDS = Number(process.env.FOLLOW_UP_DELAY_SECONDS ?? 180);

let ids: { mira: string; alex: string; nova: string };
let clock: FixedClock;

beforeAll(async () => {
  const seeded = await seedDemoScenario(prisma);
  ids = seeded.partnerIds;
});

beforeEach(async () => {
  await resetCampaignState(prisma);
  clock = new FixedClock(new Date("2026-06-01T09:00:00.000Z"));
  setClock(clock);
});

afterEach(() => {
  resetClock();
});

afterAll(async () => {
  await resetCampaignState(prisma);
  await prisma.$disconnect();
});

/** Drives a campaign to `awaiting_deliverable` with a deadline on the fixed clock. */
async function upToAwaitingDeliverable(): Promise<string> {
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
  return campaignId;
}

describe("claim query", () => {
  it("finds nothing before the deadline passes", async () => {
    await upToAwaitingDeliverable();
    expect(await claimDueCampaigns({ clock })).toEqual([]);
  });

  it("finds the campaign once the deadline passes", async () => {
    const campaignId = await upToAwaitingDeliverable();

    clock.advanceSeconds(DEADLINE_SECONDS + 1);

    // Proves the raw `FOR UPDATE SKIP LOCKED` query and its enum cast actually match rows.
    expect(await claimDueCampaigns({ clock })).toEqual([campaignId]);
  });

  it("does not hand the same campaign to a second worker while leased", async () => {
    await upToAwaitingDeliverable();
    clock.advanceSeconds(DEADLINE_SECONDS + 1);

    const first = await claimDueCampaigns({ clock, workerId: "worker-a" });
    const second = await claimDueCampaigns({ clock, workerId: "worker-b" });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("lets another worker reclaim after the lease expires", async () => {
    await upToAwaitingDeliverable();
    clock.advanceSeconds(DEADLINE_SECONDS + 1);

    await claimDueCampaigns({ clock, workerId: "worker-a" });

    // Simulate worker-a crashing: advance past the lease without releasing.
    clock.advanceSeconds(200);

    const reclaimed = await claimDueCampaigns({ clock, workerId: "worker-b" });
    expect(reclaimed).toHaveLength(1);
  });
});

describe("overdue deliverable triggers exactly one follow-up", () => {
  it("does nothing while the deliverable is not yet overdue", async () => {
    await upToAwaitingDeliverable();
    const transport = new RecordingTransport();

    const result = await runFollowUpPass({
      clock,
      transport,
      port: new ScriptedMindsPort({ replies: [buildFollowUpReply()] }),
    });

    expect(result.claimed).toBe(0);
    expect(transport.sent).toHaveLength(0);
  });

  it("sends one follow-up once overdue", async () => {
    const campaignId = await upToAwaitingDeliverable();
    clock.advanceSeconds(DEADLINE_SECONDS + 1);

    const transport = new RecordingTransport();
    const result = await runFollowUpPass({
      clock,
      transport,
      port: new ScriptedMindsPort({ replies: [buildFollowUpReply()] }),
    });

    expect(result.results[0]?.outcome).toBe("sent");
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.to).toBe("mira.chen@example.com");

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe(CampaignStatus.follow_up_sent);
    expect(campaign.followUpCount).toBe(1);
    // Nothing further scheduled — this was the only reminder.
    expect(campaign.nextActionAt).toBeNull();
  });

  it("marks the follow-up as autonomous in the audit log", async () => {
    const campaignId = await upToAwaitingDeliverable();
    clock.advanceSeconds(DEADLINE_SECONDS + 1);

    await runFollowUpPass({
      clock,
      transport: new RecordingTransport(),
      port: new ScriptedMindsPort({ replies: [buildFollowUpReply()] }),
    });

    const action = await prisma.agentAction.findFirstOrThrow({
      where: { campaignId, actionType: "followup.send" },
    });

    expect(action.status).toBe("succeeded");
    expect(action.autonomous).toBe(true);
    // No human approved this at execution time — that is the point.
    expect(action.requiresApproval).toBe(false);
    expect(action.attemptedAt).not.toBeNull();
    expect(action.executedAt).not.toBeNull();
    expect(action.transport).toBe("test-recorder");
  });

  it("records the overdue → generating → sent progression", async () => {
    const campaignId = await upToAwaitingDeliverable();
    clock.advanceSeconds(DEADLINE_SECONDS + 1);

    await runFollowUpPass({
      clock,
      transport: new RecordingTransport(),
      port: new ScriptedMindsPort({ replies: [buildFollowUpReply()] }),
    });

    const types = (
      await prisma.agentAction.findMany({ where: { campaignId } })
    ).map((a) => a.actionType);

    expect(types).toContain("campaign.follow_up_due");
    expect(types).toContain("campaign.follow_up_generating");
    expect(types).toContain("campaign.follow_up_sent");
    expect(types).toContain("followup.completed");
  });

  it("stores the follow-up message the Mind actually wrote", async () => {
    const campaignId = await upToAwaitingDeliverable();
    clock.advanceSeconds(DEADLINE_SECONDS + 1);

    await runFollowUpPass({
      clock,
      transport: new RecordingTransport(),
      port: new ScriptedMindsPort({ replies: [buildFollowUpReply()] }),
    });

    const message = await prisma.outboundMessage.findFirstOrThrow({
      where: { campaignId, kind: "follow_up" },
    });
    expect(message.body).toMatch(/wallet-safety/i);
    expect(message.transport).toBe("test-recorder");
  });

  it("gives the Mind the relationship context needed to personalise", async () => {
    await upToAwaitingDeliverable();
    clock.advanceSeconds(DEADLINE_SECONDS + 1);

    const port = new ScriptedMindsPort({ replies: [buildFollowUpReply()] });
    await runFollowUpPass({ clock, transport: new RecordingTransport(), port });

    const prompt = port.prompts[0] ?? "";
    expect(prompt).toContain("Concise and practical");
    expect(prompt).toContain("Calm, practical, evidence-based, non-hype");
    expect(prompt).toMatch(/overdue by/i);
  });
});

describe("at most one follow-up, ever", () => {
  it("does not send a second follow-up on a later pass", async () => {
    const campaignId = await upToAwaitingDeliverable();
    clock.advanceSeconds(DEADLINE_SECONDS + 1);

    const transport = new RecordingTransport();

    await runFollowUpPass({
      clock,
      transport,
      port: new ScriptedMindsPort({ replies: [buildFollowUpReply()] }),
    });

    // First line of defence: `follow_up_sent` is not an eligible status, so even a
    // re-scheduled campaign is never claimed.
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { nextActionAt: clock.now() },
    });
    clock.advanceSeconds(60);

    const notClaimed = await runFollowUpPass({
      clock,
      transport,
      port: new ScriptedMindsPort({ replies: [buildFollowUpReply()] }),
    });
    expect(notClaimed.claimed).toBe(0);

    // Second line of defence: force the campaign to LOOK eligible again (writing status
    // directly, bypassing the transition service, to simulate a corrupted row) so the
    // followUpCount guard itself is exercised rather than shadowed by the status filter.
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: CampaignStatus.awaiting_deliverable, nextActionAt: clock.now() },
    });
    clock.advanceSeconds(60);

    const second = await runFollowUpPass({
      clock,
      transport,
      port: new ScriptedMindsPort({ replies: [buildFollowUpReply()] }),
    });

    expect(second.claimed).toBe(1);
    expect(second.results[0]?.outcome).toBe("skipped_already_followed_up");
    expect(transport.sent).toHaveLength(1);
  });

  it("survives repeated passes without duplicating anything", async () => {
    const campaignId = await upToAwaitingDeliverable();
    clock.advanceSeconds(DEADLINE_SECONDS + 1);
    const transport = new RecordingTransport();

    for (let i = 0; i < 4; i += 1) {
      await runFollowUpPass({
        clock,
        transport,
        port: new ScriptedMindsPort({ replies: [buildFollowUpReply()] }),
      });
      clock.advanceSeconds(10);
    }

    expect(transport.sent).toHaveLength(1);
    expect(
      await prisma.outboundMessage.count({ where: { campaignId, kind: "follow_up" } }),
    ).toBe(1);
    expect(
      await prisma.agentAction.count({ where: { campaignId, actionType: "followup.completed" } }),
    ).toBe(1);
  });

  it("lets only one of two concurrent workers send", async () => {
    const campaignId = await upToAwaitingDeliverable();
    clock.advanceSeconds(DEADLINE_SECONDS + 1);

    const transport = new RecordingTransport();

    const [a, b] = await Promise.all([
      runFollowUpPass({
        clock,
        transport,
        workerId: "worker-a",
        port: new ScriptedMindsPort({ replies: [buildFollowUpReply()] }),
      }),
      runFollowUpPass({
        clock,
        transport,
        workerId: "worker-b",
        port: new ScriptedMindsPort({ replies: [buildFollowUpReply()] }),
      }),
    ]);

    // SKIP LOCKED means exactly one worker claims the campaign.
    expect(a.claimed + b.claimed).toBe(1);
    expect(transport.sent).toHaveLength(1);

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.followUpCount).toBe(1);
  });

  it("stands down when the compare-and-swap loses, even bypassing the lease", async () => {
    // Calls the per-campaign processor directly, so the lease cannot help. The
    // followUpCount CAS is the only thing preventing a double send here.
    const campaignId = await upToAwaitingDeliverable();
    clock.advanceSeconds(DEADLINE_SECONDS + 1);

    const transport = new RecordingTransport();

    await processClaimedCampaign(campaignId, {
      clock,
      transport,
      port: new ScriptedMindsPort({ replies: [buildFollowUpReply()] }),
    });

    // Reset state to look eligible again while leaving followUpCount at 1.
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: CampaignStatus.awaiting_deliverable, nextActionAt: clock.now() },
    });

    const second = await processClaimedCampaign(campaignId, {
      clock,
      transport,
      port: new ScriptedMindsPort({ replies: [buildFollowUpReply()] }),
    });

    expect(second.outcome).toBe("skipped_already_followed_up");
    expect(transport.sent).toHaveLength(1);
  });
});

describe("partners who must not be contacted", () => {
  it("suppresses the follow-up for an opted-out partner", async () => {
    const campaignId = await upToAwaitingDeliverable();
    clock.advanceSeconds(DEADLINE_SECONDS + 1);

    await prisma.relationship.update({
      where: {
        creatorId_partnerId: { creatorId: "creator_maya", partnerId: ids.mira },
      },
      data: { optedOut: true },
    });

    const transport = new RecordingTransport();

    try {
      const result = await runFollowUpPass({
        clock,
        transport,
        port: new ScriptedMindsPort({ replies: [buildFollowUpReply()] }),
      });

      expect(result.results[0]?.outcome).toBe("skipped_partner_unavailable");
      expect(transport.sent).toHaveLength(0);

      const suppression = await prisma.agentAction.findFirstOrThrow({
        where: { campaignId, actionType: "followup.suppressed" },
      });
      expect(suppression.reason).toMatch(/opted out/i);

      // Nothing rescheduled — we do not keep retrying a contact we must not make.
      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      expect(campaign.nextActionAt).toBeNull();
      expect(campaign.followUpCount).toBe(0);
    } finally {
      await prisma.relationship.update({
        where: {
          creatorId_partnerId: { creatorId: "creator_maya", partnerId: ids.mira },
        },
        data: { optedOut: false },
      });
    }
  });

  it("does not follow up on a deliverable that has already been submitted", async () => {
    const campaignId = await upToAwaitingDeliverable();

    await submitDeliverable({
      campaignId,
      submissionUrl: "https://example.com/early-submission",
    });

    // Force the campaign to look eligible and due (writing status directly to simulate a
    // corrupted row), so the "already submitted" guard is exercised rather than shadowed by
    // the status filter in the claim query.
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: CampaignStatus.awaiting_deliverable, nextActionAt: clock.now() },
    });
    clock.advanceSeconds(DEADLINE_SECONDS + 1);

    const transport = new RecordingTransport();
    const result = await runFollowUpPass({
      clock,
      transport,
      port: new ScriptedMindsPort({ replies: [buildFollowUpReply()] }),
    });

    expect(result.claimed).toBe(1);
    expect(result.results[0]?.outcome).toBe("skipped_not_eligible");
    expect(result.results[0]?.detail).toMatch(/already submitted/i);
    expect(transport.sent).toHaveLength(0);
  });
});

describe("failures never become false successes", () => {
  it("records a Mind failure and reschedules for retry without sending", async () => {
    const campaignId = await upToAwaitingDeliverable();
    clock.advanceSeconds(DEADLINE_SECONDS + 1);

    const transport = new RecordingTransport();
    const result = await runFollowUpPass({
      clock,
      transport,
      port: new ScriptedMindsPort({
        replies: [new MindsReplyTimeoutError("collabos-maya", 120_000)],
      }),
    });

    expect(result.results[0]?.outcome).toBe("failed");
    expect(transport.sent).toHaveLength(0);

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    // Backed out for retry, NOT stranded in follow_up_generating.
    expect(campaign.status).toBe(CampaignStatus.awaiting_deliverable);
    expect(campaign.followUpCount).toBe(0);
    expect(campaign.nextActionAt).not.toBeNull();

    const action = await prisma.agentAction.findFirstOrThrow({
      where: { campaignId, actionType: "followup.send" },
    });
    expect(action.status).toBe("failed");
    expect(action.attemptedAt).not.toBeNull();
    expect(action.executedAt).toBeNull();

    // No message row, and no completion marker, for a send that never happened.
    expect(await prisma.outboundMessage.count({ where: { campaignId, kind: "follow_up" } })).toBe(0);
    expect(
      await prisma.agentAction.count({ where: { campaignId, actionType: "followup.completed" } }),
    ).toBe(0);
  });

  it("does not advance state when the transport fails", async () => {
    const campaignId = await upToAwaitingDeliverable();
    clock.advanceSeconds(DEADLINE_SECONDS + 1);

    const transport = new RecordingTransport();
    transport.failOnce();

    await runFollowUpPass({
      clock,
      transport,
      port: new ScriptedMindsPort({ replies: [buildFollowUpReply()] }),
    });

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).not.toBe(CampaignStatus.follow_up_sent);
    expect(campaign.followUpCount).toBe(0);
  });

  it("recovers on a later pass after a transient failure", async () => {
    const campaignId = await upToAwaitingDeliverable();
    clock.advanceSeconds(DEADLINE_SECONDS + 1);

    const transport = new RecordingTransport();

    await runFollowUpPass({
      clock,
      transport,
      port: new ScriptedMindsPort({
        replies: [new MindsReplyTimeoutError("collabos-maya", 120_000)],
      }),
    });

    // Advance past the retry backoff.
    clock.advanceSeconds(120);

    const retry = await runFollowUpPass({
      clock,
      transport,
      port: new ScriptedMindsPort({ replies: [buildFollowUpReply()] }),
    });

    expect(retry.results[0]?.outcome).toBe("sent");
    expect(transport.sent).toHaveLength(1);

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe(CampaignStatus.follow_up_sent);
    expect(campaign.followUpCount).toBe(1);

    // Both the failure and the success remain provable.
    const actions = await prisma.agentAction.findMany({
      where: { campaignId, actionType: "followup.send" },
    });
    expect(actions.some((a) => a.status === "failed")).toBe(true);
    expect(actions.some((a) => a.status === "succeeded")).toBe(true);
  });

  it("stops retrying after the bounded attempt limit", async () => {
    const campaignId = await upToAwaitingDeliverable();
    clock.advanceSeconds(DEADLINE_SECONDS + 1);

    const transport = new RecordingTransport();

    for (let attempt = 0; attempt < MAX_FOLLOW_UP_ATTEMPTS; attempt += 1) {
      await runFollowUpPass({
        clock,
        transport,
        port: new ScriptedMindsPort({
          replies: [new MindsReplyTimeoutError("collabos-maya", 120_000)],
        }),
      });
      clock.advanceSeconds(120);
    }

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    // Retry budget spent: nothing more is scheduled.
    expect(campaign.nextActionAt).toBeNull();
    expect(campaign.followUpCount).toBe(0);
    expect(transport.sent).toHaveLength(0);

    // A further pass claims nothing at all.
    const extra = await runFollowUpPass({
      clock,
      transport,
      port: new ScriptedMindsPort({ replies: [buildFollowUpReply()] }),
    });
    expect(extra.claimed).toBe(0);
  });
});
