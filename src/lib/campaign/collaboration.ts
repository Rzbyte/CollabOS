/**
 * Outreach, acceptance, Circle admission, and campaign setup.
 *
 * `advanceAfterAcceptance()` is written as a RESUMABLE state pump rather than a linear
 * script. Three external systems participate (the Mind, the Circle API, SMTP), so any of
 * the steps can fail midway. Making the function idempotent and re-runnable means a failed
 * Circle mutation leaves the campaign at `circle_add_pending` — honestly stuck, never
 * falsely `circle_added` — and the creator can retry without unwinding anything.
 *
 * That property is also what §3's continuity claim rests on: the campaign's position lives
 * in Postgres, so a later session or worker run picks up exactly where this left off.
 */
import { loadEnv } from "../../env.ts";
import { DeliverableStatus, RelationshipStatus } from "../../generated/prisma/enums.ts";
import { ApprovalActionType, ApprovalStatus, OutboundMessageKind } from "../../generated/prisma/enums.ts";
import {
  beginAction,
  logApproval,
  logEvent,
  markAttempted,
  markFailed,
  markSucceeded,
} from "../audit/log.ts";
import { getClock } from "../clock.ts";
import { addApprovedCollaboratorToCircle } from "../circle/service.ts";
import { prisma } from "../db.ts";
import { getEmailTransport, type EmailTransport } from "../email/transport.ts";
import { collaborationUrl } from "../links/sign.ts";
import { getMindsPort, newCorrelationId, type MindsPort } from "../minds/client.ts";
import { CollabOsMindsError, toCollabOsMindsError } from "../minds/errors.ts";
import { buildCampaignBriefPrompt, buildOutreachPrompt } from "../minds/prompts.ts";
import { requestCampaignBrief, requestOutreachMessage } from "../minds/reasoning.ts";
import {
  BrandSafetyViolationError,
  PartnerContactBlockedError,
  assessPartnerSafety,
} from "../safety/brand-safety.ts";
import { isPartnerRejectedForCampaign } from "./service.ts";
import { CampaignStatus } from "./states.ts";
import { transitionCampaign } from "./transition.ts";

export interface StepResult {
  ok: boolean;
  /** Machine-readable summary of what the pump managed to do. */
  reached: CampaignStatus;
  steps: string[];
  error?: { code: string; message: string };
}

/**
 * Creator approves first contact, then CollabOS composes and sends it.
 *
 * Safety is re-checked here rather than trusted from the earlier approval: time has passed,
 * and an opt-out or rejection recorded in between must still block the send.
 */
export async function approveAndSendOutreach(input: {
  campaignId: string;
  port?: MindsPort;
  transport?: EmailTransport;
}): Promise<StepResult> {
  const port = input.port ?? getMindsPort();
  const transport = input.transport ?? getEmailTransport();
  const correlationId = newCorrelationId();

  const campaign = await prisma.campaign.findUnique({
    where: { id: input.campaignId },
    include: { creator: true, approvedPartner: true },
  });
  if (!campaign) throw new Error(`Campaign ${input.campaignId} not found.`);

  // Idempotency: already sent.
  if (
    campaign.status !== CampaignStatus.outreach_approval_required &&
    campaign.status !== CampaignStatus.outreach_approved
  ) {
    return { ok: true, reached: campaign.status, steps: ["outreach already handled"] };
  }

  const partner = campaign.approvedPartner;
  if (!partner) throw new Error("No approved partner on this campaign.");

  const safety = assessPartnerSafety(campaign.creator.prohibitedTopics, partner);
  if (safety.blocked) throw new BrandSafetyViolationError(partner.name, safety.conflicts);

  const relationship = await prisma.relationship.findUnique({
    where: {
      creatorId_partnerId: { creatorId: campaign.creatorId, partnerId: partner.id },
    },
  });
  if (relationship?.optedOut) {
    throw new PartnerContactBlockedError(partner.name, "opted_out");
  }
  if (await isPartnerRejectedForCampaign(campaign.id, partner.id)) {
    throw new PartnerContactBlockedError(partner.name, "rejected");
  }

  const steps: string[] = [];

  // ------------------------------------------------- record the creator's approval
  const pending = await prisma.approval.findFirst({
    where: {
      campaignId: campaign.id,
      actionType: ApprovalActionType.first_outreach,
      status: ApprovalStatus.pending,
    },
  });

  if (pending) {
    await prisma.approval.update({
      where: { id: pending.id },
      data: { status: ApprovalStatus.approved, approvedAt: getClock().now() },
    });

    await logApproval({
      campaignId: campaign.id,
      correlationId,
      actionType: "approval.first_outreach",
      summary: `Creator approved first outreach to ${partner.name}`,
      decision: "approved",
      reason: "Human control gate: first external contact is never automatic.",
    });
    steps.push("first outreach approved by creator");
  }

  if (campaign.status === CampaignStatus.outreach_approval_required) {
    await transitionCampaign({
      campaignId: campaign.id,
      to: CampaignStatus.outreach_approved,
      actionType: "campaign.outreach_approved",
      summary: `Outreach to ${partner.name} authorised`,
      correlationId,
      expectedFrom: [CampaignStatus.outreach_approval_required],
    });
  }

  // ------------------------------------------------------- compose and send
  const actionId = await beginAction({
    campaignId: campaign.id,
    correlationId,
    actionType: "outreach.send",
    summary: `Compose and send first outreach to ${partner.name}`,
    transport: transport.name,
    reason: `Authored by the Mind in ${campaign.creator.name}'s brand voice.`,
  });

  try {
    await markAttempted(actionId, { transport: transport.name });

    const acceptUrl = collaborationUrl(campaign.id);

    await port.ensureConversation(campaign.creator.mindConversationAlias);

    const message = await requestOutreachMessage({
      port,
      alias: campaign.creator.mindConversationAlias,
      campaignId: campaign.id,
      correlationId,
      prompt: buildOutreachPrompt({
        creator: campaign.creator,
        partner,
        relationship,
        objective: campaign.objective,
        acceptUrl,
      }),
    });

    // The Mind is asked to include the link, but the send must not depend on it obeying.
    const body = message.value.body.includes(acceptUrl)
      ? message.value.body
      : `${message.value.body}\n\nAccept the collaboration: ${acceptUrl}`;

    const sent = await transport.send({
      to: partner.email,
      subject: message.value.subject,
      body,
      fromName: campaign.creator.name,
    });

    await prisma.outboundMessage.create({
      data: {
        campaignId: campaign.id,
        kind: OutboundMessageKind.outreach,
        transport: sent.transport,
        toEmail: partner.email,
        subject: message.value.subject,
        body,
        sentAt: getClock().now(),
        externalReference: sent.externalReference,
      },
    });

    await markSucceeded(actionId, {
      externalReference: sent.externalReference,
      transport: sent.transport,
      summary: `Outreach sent to ${partner.name} via ${transport.label}`,
    });

    await prisma.relationship.upsert({
      where: {
        creatorId_partnerId: { creatorId: campaign.creatorId, partnerId: partner.id },
      },
      create: {
        creatorId: campaign.creatorId,
        partnerId: partner.id,
        status: RelationshipStatus.contacted,
        lastContactedAt: getClock().now(),
      },
      update: {
        status: RelationshipStatus.contacted,
        lastContactedAt: getClock().now(),
      },
    });

    await transitionCampaign({
      campaignId: campaign.id,
      to: CampaignStatus.outreach_sent,
      actionType: "campaign.outreach_sent",
      summary: `Awaiting ${partner.name}'s response`,
      correlationId,
      expectedFrom: [CampaignStatus.outreach_approved],
    });

    steps.push(`outreach sent via ${transport.name}`);
    return { ok: true, reached: CampaignStatus.outreach_sent, steps };
  } catch (error) {
    await markFailed(actionId, error);
    const typed = toCollabOsMindsError(error, correlationId);

    // Left at `outreach_approved` so it can be retried; the failure is recorded.
    return {
      ok: false,
      reached: CampaignStatus.outreach_approved,
      steps,
      error: { code: typed.code, message: typed.message },
    };
  }
}

/**
 * The collaborator accepts, from the signed link.
 *
 * Called from an unauthenticated page, so it does exactly one thing — record acceptance —
 * and takes no caller-supplied identity or address.
 */
export async function acceptCollaboration(input: {
  campaignId: string;
  port?: MindsPort;
}): Promise<StepResult> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: input.campaignId },
    include: { approvedPartner: true },
  });
  if (!campaign) throw new Error(`Campaign ${input.campaignId} not found.`);

  const correlationId = newCorrelationId();

  if (campaign.status === CampaignStatus.outreach_sent) {
    await logEvent({
      campaignId: campaign.id,
      correlationId,
      actionType: "collaboration.accepted",
      summary: `${campaign.approvedPartner?.name ?? "Collaborator"} accepted the collaboration`,
      reason: "Recorded from the signed collaborator link — never inferred or fabricated.",
    });

    await transitionCampaign({
      campaignId: campaign.id,
      to: CampaignStatus.partner_accepted,
      actionType: "campaign.partner_accepted",
      summary: `${campaign.approvedPartner?.name ?? "Collaborator"} accepted`,
      correlationId,
      expectedFrom: [CampaignStatus.outreach_sent],
    });

    if (campaign.approvedPartnerId) {
      await prisma.relationship.upsert({
        where: {
          creatorId_partnerId: {
            creatorId: campaign.creatorId,
            partnerId: campaign.approvedPartnerId,
          },
        },
        create: {
          creatorId: campaign.creatorId,
          partnerId: campaign.approvedPartnerId,
          status: RelationshipStatus.active,
          previousResponse: "Accepted the collaboration invitation.",
        },
        update: {
          status: RelationshipStatus.active,
          previousResponse: "Accepted the collaboration invitation.",
        },
      });
    }
  }

  return advanceAfterAcceptance({
    campaignId: campaign.id,
    ...(input.port ? { port: input.port } : {}),
  });
}

/**
 * Resumable pump: partner_accepted → circle_added → campaign_active → awaiting_deliverable.
 *
 * Safe to call repeatedly. Each block is guarded by the current state, so a retry after a
 * partial failure resumes rather than repeating completed work.
 */
export async function advanceAfterAcceptance(input: {
  campaignId: string;
  port?: MindsPort;
}): Promise<StepResult> {
  const port = input.port ?? getMindsPort();
  const env = loadEnv();
  const correlationId = newCorrelationId();
  const steps: string[] = [];

  let campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: input.campaignId },
    include: { creator: true, approvedPartner: true },
  });

  const reload = async () => {
    campaign = await prisma.campaign.findUniqueOrThrow({
      where: { id: input.campaignId },
      include: { creator: true, approvedPartner: true },
    });
  };

  // ------------------------------------------------- 1. open the Circle add step
  if (campaign.status === CampaignStatus.partner_accepted) {
    await transitionCampaign({
      campaignId: campaign.id,
      to: CampaignStatus.circle_add_pending,
      actionType: "campaign.circle_add_pending",
      summary: `Preparing to add the collaborator to the Mind's Circle`,
      correlationId,
      expectedFrom: [CampaignStatus.partner_accepted],
    });
    await reload();
  }

  // ---------------------------------------------------------- 2. mutate the Circle
  if (campaign.status === CampaignStatus.circle_add_pending) {
    try {
      const outcome = await addApprovedCollaboratorToCircle({
        campaignId: campaign.id,
        port,
      });

      steps.push(
        outcome.status === "already_member"
          ? "collaborator already in Circle (idempotent)"
          : "collaborator added to Circle",
      );

      // Only reached on a CONFIRMED platform result.
      await transitionCampaign({
        campaignId: campaign.id,
        to: CampaignStatus.circle_added,
        actionType: "campaign.circle_added",
        summary: `Collaborator is in the Mind's trusted Circle`,
        correlationId,
        expectedFrom: [CampaignStatus.circle_add_pending],
      });
      await reload();
    } catch (error) {
      const typed = toCollabOsMindsError(error, correlationId);
      // Deliberately stuck at circle_add_pending — never falsely `circle_added`.
      return {
        ok: false,
        reached: CampaignStatus.circle_add_pending,
        steps,
        error: { code: typed.code, message: typed.message },
      };
    }
  }

  // ------------------------------------------- 3. brief + deliverable, then activate
  if (campaign.status === CampaignStatus.circle_added) {
    const partner = campaign.approvedPartner;
    if (!partner) throw new Error("No approved partner on this campaign.");

    const briefAction = await beginAction({
      campaignId: campaign.id,
      correlationId,
      actionType: "mind.campaign_brief",
      summary: `Author the shared campaign brief with the Mind`,
    });

    try {
      await markAttempted(briefAction);

      const relationship = await prisma.relationship.findUnique({
        where: {
          creatorId_partnerId: { creatorId: campaign.creatorId, partnerId: partner.id },
        },
      });

      await port.ensureConversation(campaign.creator.mindConversationAlias);

      const brief = await requestCampaignBrief({
        port,
        alias: campaign.creator.mindConversationAlias,
        campaignId: campaign.id,
        correlationId,
        prompt: buildCampaignBriefPrompt({
          creator: campaign.creator,
          partner,
          relationship,
          objective: campaign.objective,
        }),
      });

      await prisma.campaignBrief.upsert({
        where: { campaignId: campaign.id },
        create: {
          campaignId: campaign.id,
          title: brief.value.title,
          summary: brief.value.summary,
          talkingPoints: brief.value.talkingPoints,
          toneNotes: brief.value.toneNotes ?? null,
          successMetric: brief.value.successMetric ?? null,
        },
        update: {
          title: brief.value.title,
          summary: brief.value.summary,
          talkingPoints: brief.value.talkingPoints,
          toneNotes: brief.value.toneNotes ?? null,
          successMetric: brief.value.successMetric ?? null,
        },
      });

      await markSucceeded(briefAction, {
        externalReference: brief.exchangeId,
        summary: `Campaign brief created: "${brief.value.title}"`,
      });
      steps.push("campaign brief created");
    } catch (error) {
      await markFailed(briefAction, error);
      const typed = toCollabOsMindsError(error, correlationId);
      return {
        ok: false,
        reached: CampaignStatus.circle_added,
        steps,
        error: { code: typed.code, message: typed.message },
      };
    }

    // The deadline that makes the autonomous follow-up demonstrable.
    const now = getClock().now();
    const dueAt = new Date(now.getTime() + env.FOLLOW_UP_DELAY_SECONDS * 1000);

    const existing = await prisma.deliverable.findFirst({
      where: { campaignId: campaign.id },
    });

    if (!existing) {
      await prisma.deliverable.create({
        data: {
          campaignId: campaign.id,
          title: "Wallet-safety collaboration segment",
          description:
            "Record and submit the agreed collaboration segment for the wallet-safety " +
            "launch video, following the shared campaign brief.",
          status: DeliverableStatus.awaiting_submission,
          dueAt,
        },
      });

      await logEvent({
        campaignId: campaign.id,
        correlationId,
        actionType: "deliverable.created",
        summary: `Deliverable created, due ${dueAt.toISOString().replace("T", " ").slice(0, 19)}Z`,
        reason: `Development deadline of ${env.FOLLOW_UP_DELAY_SECONDS}s from creation.`,
      });
      steps.push("deliverable created");
    }

    await transitionCampaign({
      campaignId: campaign.id,
      to: CampaignStatus.campaign_active,
      actionType: "campaign.active",
      summary: `Collaboration active with ${partner.name}`,
      correlationId,
      expectedFrom: [CampaignStatus.circle_added],
    });

    // `nextActionAt` is what the worker polls. Setting it here is the only thing that
    // schedules autonomy — there is no button.
    await transitionCampaign({
      campaignId: campaign.id,
      to: CampaignStatus.awaiting_deliverable,
      actionType: "campaign.awaiting_deliverable",
      summary: `Awaiting deliverable from ${partner.name}`,
      correlationId,
      expectedFrom: [CampaignStatus.campaign_active],
      campaignData: { deadline: dueAt, nextActionAt: dueAt },
    });

    steps.push("campaign awaiting deliverable");
    await reload();
  }

  return { ok: true, reached: campaign.status, steps };
}

/**
 * The collaborator submits their deliverable from the signed link.
 *
 * The submission URL is collaborator-supplied, so it is length-capped and stored as text.
 * It is never fetched or rendered as a link target by CollabOS.
 */
export async function submitDeliverable(input: {
  campaignId: string;
  submissionUrl: string;
  note?: string;
}): Promise<StepResult> {
  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: input.campaignId },
    include: { approvedPartner: true, deliverables: true },
  });

  const deliverable = campaign.deliverables[0];
  if (!deliverable) throw new Error("This campaign has no deliverable to submit.");

  const submittable: CampaignStatus[] = [
    CampaignStatus.awaiting_deliverable,
    CampaignStatus.follow_up_due,
    CampaignStatus.follow_up_sent,
  ];

  if (!submittable.includes(campaign.status)) {
    return {
      ok: true,
      reached: campaign.status,
      steps: ["deliverable already submitted"],
    };
  }

  const correlationId = newCorrelationId();
  const now = getClock().now();

  await prisma.deliverable.update({
    where: { id: deliverable.id },
    data: {
      status: DeliverableStatus.submitted,
      submittedAt: now,
      submissionUrl: input.submissionUrl.slice(0, 2000),
      submissionNote: input.note?.slice(0, 1000) ?? null,
    },
  });

  await logEvent({
    campaignId: campaign.id,
    correlationId,
    actionType: "deliverable.submitted",
    summary: `${campaign.approvedPartner?.name ?? "Collaborator"} submitted the deliverable`,
    reason: "Submitted through the signed collaborator link.",
  });

  await transitionCampaign({
    campaignId: campaign.id,
    to: CampaignStatus.deliverable_received,
    actionType: "campaign.deliverable_received",
    summary: `Deliverable received from ${campaign.approvedPartner?.name ?? "collaborator"}`,
    correlationId,
    expectedFrom: submittable,
    // Clearing nextActionAt stops the worker considering this campaign.
    campaignData: { nextActionAt: null },
  });

  await transitionCampaign({
    campaignId: campaign.id,
    to: CampaignStatus.final_approval_required,
    actionType: "campaign.final_approval_required",
    summary: `Awaiting creator's final approval of the deliverable`,
    correlationId,
    expectedFrom: [CampaignStatus.deliverable_received],
  });

  await prisma.approval.create({
    data: {
      campaignId: campaign.id,
      actionType: ApprovalActionType.final_deliverable,
      payload: {
        deliverableId: deliverable.id,
        submissionUrl: input.submissionUrl.slice(0, 2000),
      },
      status: ApprovalStatus.pending,
      requestedAt: now,
    },
  });

  return {
    ok: true,
    reached: CampaignStatus.final_approval_required,
    steps: ["deliverable submitted", "final approval requested"],
  };
}

export { CollabOsMindsError };
