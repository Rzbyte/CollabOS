/**
 * Integration: outreach → acceptance → Circle admission → brief → awaiting deliverable.
 *
 * Covers from CLAUDE.md §20:
 *   • integration — partner approval to Circle add attempt
 *   • unit — idempotent Circle addition
 *   • integration — failed external action does not produce a false success state
 *   • integration — deliverable submission to final approval
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../../src/lib/db.ts";
import { CampaignStatus } from "../../src/lib/campaign/states.ts";
import {
  acceptCollaboration,
  advanceAfterAcceptance,
  approveAndSendOutreach,
  submitDeliverable,
} from "../../src/lib/campaign/collaboration.ts";
import { approvePartner, submitObjective } from "../../src/lib/campaign/service.ts";
import { CollabOsMindsError } from "../../src/lib/minds/errors.ts";
import { resetCampaignState, seedDemoScenario } from "../../src/lib/seed/demo-seed.ts";
import { RecordingTransport } from "../helpers/fake-transport.ts";
import {
  ScriptedMindsPort,
  buildBriefReply,
  buildOutreachReply,
  buildRankingReply,
} from "../helpers/scripted-port.ts";

const OBJECTIVE =
  "Launch a wallet-safety educational video and grow my beginner audience through one collaboration.";

let ids: { mira: string; alex: string; nova: string };

beforeAll(async () => {
  const seeded = await seedDemoScenario(prisma);
  ids = seeded.partnerIds;
});

beforeEach(async () => {
  await resetCampaignState(prisma);
});

afterAll(async () => {
  await resetCampaignState(prisma);
  await prisma.$disconnect();
});

/** Advances a fresh campaign to `outreach_approval_required`. */
async function upToOutreachGate(): Promise<string> {
  const port = new ScriptedMindsPort({ replies: [buildRankingReply(ids)] });
  const { campaignId } = await submitObjective({ objective: OBJECTIVE, port });
  await approvePartner({ campaignId, partnerId: ids.mira });
  return campaignId;
}

describe("first outreach", () => {
  it("sends through the transport and advances to outreach_sent", async () => {
    const campaignId = await upToOutreachGate();
    const port = new ScriptedMindsPort({ replies: [buildOutreachReply()] });
    const transport = new RecordingTransport();

    const result = await approveAndSendOutreach({ campaignId, port, transport });

    expect(result.ok).toBe(true);
    expect(transport.sent).toHaveLength(1);

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe(CampaignStatus.outreach_sent);
  });

  it("appends the acceptance link when the Mind omits it", async () => {
    // The Mind is asked to include the link, but delivery must not depend on compliance.
    const campaignId = await upToOutreachGate();
    const port = new ScriptedMindsPort({ replies: [buildOutreachReply()] });
    const transport = new RecordingTransport();

    await approveAndSendOutreach({ campaignId, port, transport });

    expect(transport.sent[0]?.body).toContain("/collab/");
  });

  it("marks the first_outreach approval as approved", async () => {
    const campaignId = await upToOutreachGate();
    const port = new ScriptedMindsPort({ replies: [buildOutreachReply()] });

    await approveAndSendOutreach({ campaignId, port, transport: new RecordingTransport() });

    const approval = await prisma.approval.findFirstOrThrow({
      where: { campaignId, actionType: "first_outreach" },
    });
    expect(approval.status).toBe("approved");
    expect(approval.approvedAt).not.toBeNull();
  });

  it("stores the sent message with its transport for the audit trail", async () => {
    const campaignId = await upToOutreachGate();
    const port = new ScriptedMindsPort({ replies: [buildOutreachReply()] });
    const transport = new RecordingTransport();

    await approveAndSendOutreach({ campaignId, port, transport });

    const message = await prisma.outboundMessage.findFirstOrThrow({ where: { campaignId } });
    expect(message.kind).toBe("outreach");
    expect(message.transport).toBe("test-recorder");
    expect(message.sentAt).not.toBeNull();
  });

  it("records the send as attempted AND succeeded with the transport named", async () => {
    const campaignId = await upToOutreachGate();
    const port = new ScriptedMindsPort({ replies: [buildOutreachReply()] });

    await approveAndSendOutreach({ campaignId, port, transport: new RecordingTransport() });

    const action = await prisma.agentAction.findFirstOrThrow({
      where: { campaignId, actionType: "outreach.send" },
    });
    expect(action.status).toBe("succeeded");
    expect(action.attemptedAt).not.toBeNull();
    expect(action.executedAt).not.toBeNull();
    expect(action.transport).toBe("test-recorder");
  });

  it("does not advance to outreach_sent when the transport fails", async () => {
    const campaignId = await upToOutreachGate();
    const port = new ScriptedMindsPort({ replies: [buildOutreachReply()] });
    const transport = new RecordingTransport();
    transport.failOnce();

    const result = await approveAndSendOutreach({ campaignId, port, transport });

    expect(result.ok).toBe(false);

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe(CampaignStatus.outreach_approved);
    expect(campaign.status).not.toBe(CampaignStatus.outreach_sent);

    // No message row may exist for a send that did not happen.
    expect(await prisma.outboundMessage.count({ where: { campaignId } })).toBe(0);

    const action = await prisma.agentAction.findFirstOrThrow({
      where: { campaignId, actionType: "outreach.send" },
    });
    expect(action.status).toBe("failed");
    expect(action.attemptedAt).not.toBeNull();
    expect(action.executedAt).toBeNull();
  });

  it("is idempotent once sent", async () => {
    const campaignId = await upToOutreachGate();
    const transport = new RecordingTransport();

    await approveAndSendOutreach({
      campaignId,
      port: new ScriptedMindsPort({ replies: [buildOutreachReply()] }),
      transport,
    });
    const second = await approveAndSendOutreach({
      campaignId,
      port: new ScriptedMindsPort({ replies: [buildOutreachReply()] }),
      transport,
    });

    expect(second.steps).toContain("outreach already handled");
    expect(transport.sent).toHaveLength(1); // not sent twice
  });
});

describe("acceptance, Circle admission, and campaign setup", () => {
  async function upToSent(): Promise<string> {
    const campaignId = await upToOutreachGate();
    await approveAndSendOutreach({
      campaignId,
      port: new ScriptedMindsPort({ replies: [buildOutreachReply()] }),
      transport: new RecordingTransport(),
    });
    return campaignId;
  }

  it("runs the full pump to awaiting_deliverable", async () => {
    const campaignId = await upToSent();
    const port = new ScriptedMindsPort({ replies: [buildBriefReply()] });

    const result = await acceptCollaboration({ campaignId, port });

    expect(result.ok).toBe(true);
    expect(result.reached).toBe(CampaignStatus.awaiting_deliverable);

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe(CampaignStatus.awaiting_deliverable);

    // Scheduling the worker is the ONLY thing that creates autonomy — no button exists.
    expect(campaign.nextActionAt).not.toBeNull();
    expect(campaign.deadline).not.toBeNull();
  });

  it("adds the configured collaborator to the Circle", async () => {
    const campaignId = await upToSent();
    const port = new ScriptedMindsPort({ replies: [buildBriefReply()] });

    await acceptCollaboration({ campaignId, port });

    const membership = await prisma.circleMembership.findFirstOrThrow({
      where: { campaignId },
    });
    expect(membership.status).toBe("active");
    expect(membership.addedAt).not.toBeNull();
    expect(membership.externalReference).toBeTruthy();

    // The address came from configuration, never from the request.
    expect(membership.collaboratorEmail).toBe(
      (process.env.COLLABORATOR_TEST_EMAIL ?? "").trim().toLowerCase(),
    );
  });

  it("creates the brief and one deliverable with a deadline", async () => {
    const campaignId = await upToSent();
    const port = new ScriptedMindsPort({ replies: [buildBriefReply()] });

    await acceptCollaboration({ campaignId, port });

    const brief = await prisma.campaignBrief.findUniqueOrThrow({ where: { campaignId } });
    expect(brief.talkingPoints.length).toBeGreaterThan(0);

    const deliverables = await prisma.deliverable.findMany({ where: { campaignId } });
    expect(deliverables).toHaveLength(1);
    expect(deliverables[0]?.dueAt).not.toBeNull();
    expect(deliverables[0]?.status).toBe("awaiting_submission");
  });

  it("records the Circle addition as attempted and succeeded", async () => {
    const campaignId = await upToSent();
    await acceptCollaboration({
      campaignId,
      port: new ScriptedMindsPort({ replies: [buildBriefReply()] }),
    });

    const action = await prisma.agentAction.findFirstOrThrow({
      where: { campaignId, actionType: "circle.add" },
    });
    expect(action.status).toBe("succeeded");
    expect(action.attemptedAt).not.toBeNull();
    expect(action.executedAt).not.toBeNull();
  });

  it("is idempotent — re-accepting changes nothing and does not duplicate work", async () => {
    const campaignId = await upToSent();

    await acceptCollaboration({
      campaignId,
      port: new ScriptedMindsPort({ replies: [buildBriefReply()] }),
    });

    // A second run with NO scripted replies would throw if it tried to ask the Mind again.
    const second = await acceptCollaboration({
      campaignId,
      port: new ScriptedMindsPort({ replies: [] }),
    });

    expect(second.ok).toBe(true);
    expect(second.reached).toBe(CampaignStatus.awaiting_deliverable);

    expect(await prisma.deliverable.count({ where: { campaignId } })).toBe(1);
    expect(await prisma.circleMembership.count({ where: { campaignId } })).toBe(1);
  });

  it("treats an already-present Circle member as success", async () => {
    const campaignId = await upToSent();
    const email = (process.env.COLLABORATOR_TEST_EMAIL ?? "").trim().toLowerCase();

    // Pre-populate the Circle so the platform reports "already a member".
    const port = new ScriptedMindsPort({
      replies: [buildBriefReply()],
      circle: [{ email, isSteward: false }],
    });

    const result = await acceptCollaboration({ campaignId, port });

    expect(result.ok).toBe(true);
    expect(result.steps.join(" ")).toMatch(/already in Circle/i);

    const membership = await prisma.circleMembership.findFirstOrThrow({
      where: { campaignId },
    });
    expect(membership.status).toBe("already_member");

    // Still reaches the same end state — idempotent success, not an error.
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe(CampaignStatus.awaiting_deliverable);
  });
});

describe("failed Circle mutation never shows as circle_added", () => {
  async function upToSent(): Promise<string> {
    const campaignId = await upToOutreachGate();
    await approveAndSendOutreach({
      campaignId,
      port: new ScriptedMindsPort({ replies: [buildOutreachReply()] }),
      transport: new RecordingTransport(),
    });
    return campaignId;
  }

  it("leaves the campaign at circle_add_pending", async () => {
    const campaignId = await upToSent();
    const port = new ScriptedMindsPort({
      replies: [buildBriefReply()],
      circleAddError: new CollabOsMindsError({
        code: "MINDS_TRANSPORT_ERROR",
        message: "Circle service unavailable",
      }),
    });

    const result = await acceptCollaboration({ campaignId, port });

    expect(result.ok).toBe(false);
    expect(result.reached).toBe(CampaignStatus.circle_add_pending);

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe(CampaignStatus.circle_add_pending);
    expect(campaign.status).not.toBe(CampaignStatus.circle_added);
  });

  it("stores the membership as failed, not active", async () => {
    const campaignId = await upToSent();
    const port = new ScriptedMindsPort({
      replies: [buildBriefReply()],
      circleAddError: new CollabOsMindsError({
        code: "MINDS_TRANSPORT_ERROR",
        message: "Circle service unavailable",
      }),
    });

    await acceptCollaboration({ campaignId, port });

    const membership = await prisma.circleMembership.findFirstOrThrow({
      where: { campaignId },
    });
    expect(membership.status).toBe("failed");
    expect(membership.addedAt).toBeNull();
  });

  it("does not create a brief or deliverable behind a failed Circle step", async () => {
    const campaignId = await upToSent();
    const port = new ScriptedMindsPort({
      replies: [buildBriefReply()],
      circleAddError: new CollabOsMindsError({
        code: "MINDS_TRANSPORT_ERROR",
        message: "Circle service unavailable",
      }),
    });

    await acceptCollaboration({ campaignId, port });

    expect(await prisma.campaignBrief.count({ where: { campaignId } })).toBe(0);
    expect(await prisma.deliverable.count({ where: { campaignId } })).toBe(0);

    // Nothing is scheduled, so the worker will not act on a half-built campaign.
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.nextActionAt).toBeNull();
  });

  it("resumes cleanly once the Circle works again", async () => {
    const campaignId = await upToSent();

    await acceptCollaboration({
      campaignId,
      port: new ScriptedMindsPort({
        replies: [],
        circleAddError: new CollabOsMindsError({
          code: "MINDS_TRANSPORT_ERROR",
          message: "Circle service unavailable",
        }),
      }),
    });

    const recovered = await advanceAfterAcceptance({
      campaignId,
      port: new ScriptedMindsPort({ replies: [buildBriefReply()] }),
    });

    expect(recovered.ok).toBe(true);
    expect(recovered.reached).toBe(CampaignStatus.awaiting_deliverable);

    const membership = await prisma.circleMembership.findFirstOrThrow({
      where: { campaignId },
    });
    expect(membership.status).toBe("active");

    // Both the failure and the recovery remain visible.
    const actions = await prisma.agentAction.findMany({
      where: { campaignId, actionType: "circle.add" },
    });
    expect(actions.some((a) => a.status === "failed")).toBe(true);
    expect(actions.some((a) => a.status === "succeeded")).toBe(true);
  });
});

describe("deliverable submission", () => {
  async function upToAwaiting(): Promise<string> {
    const campaignId = await upToOutreachGate();
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

  it("moves to final_approval_required and opens the approval gate", async () => {
    const campaignId = await upToAwaiting();

    const result = await submitDeliverable({
      campaignId,
      submissionUrl: "https://example.com/mira-wallet-safety-segment",
      note: "Came in a little under three minutes.",
    });

    expect(result.ok).toBe(true);

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe(CampaignStatus.final_approval_required);

    // Autonomy is stood down once the deliverable arrives.
    expect(campaign.nextActionAt).toBeNull();

    const approval = await prisma.approval.findFirstOrThrow({
      where: { campaignId, actionType: "final_deliverable" },
    });
    expect(approval.status).toBe("pending");
  });

  it("stores the submission against the deliverable", async () => {
    const campaignId = await upToAwaiting();

    await submitDeliverable({
      campaignId,
      submissionUrl: "https://example.com/segment",
      note: "Done",
    });

    const deliverable = await prisma.deliverable.findFirstOrThrow({ where: { campaignId } });
    expect(deliverable.status).toBe("submitted");
    expect(deliverable.submittedAt).not.toBeNull();
    expect(deliverable.submissionUrl).toBe("https://example.com/segment");
  });

  it("is idempotent — a double submission does not re-open the gate", async () => {
    const campaignId = await upToAwaiting();

    await submitDeliverable({ campaignId, submissionUrl: "https://example.com/a" });
    const second = await submitDeliverable({
      campaignId,
      submissionUrl: "https://example.com/b",
    });

    expect(second.steps).toContain("deliverable already submitted");
    expect(await prisma.approval.count({ where: { campaignId, actionType: "final_deliverable" } })).toBe(1);

    // The first submission stands; the second did not overwrite it.
    const deliverable = await prisma.deliverable.findFirstOrThrow({ where: { campaignId } });
    expect(deliverable.submissionUrl).toBe("https://example.com/a");
  });
});
