/**
 * Circle management (CLAUDE.md §16).
 *
 * Circles are the Minds platform's real trust gate — "Circles are how Minds and humans get
 * permission to talk to each other" — so adding a collaborator is a genuine permission
 * change, not a cosmetic status flip. That drives every rule here:
 *
 *   • The email comes from `COLLABORATOR_TEST_EMAIL` ONLY. It is never taken from browser
 *     input, even though the collaborator page that triggers this is unauthenticated. A
 *     visitor with a valid link can cause the *configured* address to be added and nothing
 *     else.
 *   • Creator approval is verified from the database before any mutation.
 *   • Membership is read before mutating and confirmed after, so success is something the
 *     platform reported rather than something CollabOS assumed.
 *   • "Already in the Circle" is success, not an error — the operation is idempotent.
 *   • A failure leaves the stored status as `failed`. The campaign is never advanced to
 *     `circle_added` on a failed mutation.
 */
import { loadEnv } from "../../env.ts";
import { ApprovalActionType, ApprovalStatus, CircleMembershipStatus } from "../../generated/prisma/enums.ts";
import { beginAction, markAttempted, markFailed, markSucceeded } from "../audit/log.ts";
import { prisma } from "../db.ts";
import {
  assertHumanCollaboratorEmail,
  getMindsPort,
  newCorrelationId,
  type MindsPort,
} from "../minds/client.ts";
import { CollabOsMindsError } from "../minds/errors.ts";

export class CollaboratorNotConfiguredError extends Error {
  readonly code = "COLLABORATOR_NOT_CONFIGURED";
  constructor() {
    super(
      "COLLABORATOR_TEST_EMAIL is not set. Add an inbox you control to .env — it is the " +
        "only address CollabOS will add to the Mind's Circle.",
    );
    this.name = "CollaboratorNotConfiguredError";
  }
}

export class CreatorApprovalMissingError extends Error {
  readonly code = "CREATOR_APPROVAL_MISSING";
  constructor(what: string) {
    super(`Refusing to proceed: no approved creator authorisation found for ${what}.`);
    this.name = "CreatorApprovalMissingError";
  }
}

export interface CircleAddOutcome {
  status: "added" | "already_member";
  collaboratorEmail: string;
  memberCount: number;
  reference: string;
}

/**
 * Adds the configured collaborator to the Mind's Circle.
 *
 * Idempotent at two levels: the platform reports `alreadyInCircle`, and the local
 * `CircleMembership` row is upserted on `(campaignId, collaboratorEmail)`.
 */
export async function addApprovedCollaboratorToCircle(input: {
  campaignId: string;
  port?: MindsPort;
}): Promise<CircleAddOutcome> {
  const env = loadEnv();
  const port = input.port ?? getMindsPort();

  const email = env.COLLABORATOR_TEST_EMAIL.trim().toLowerCase();
  if (!email) throw new CollaboratorNotConfiguredError();

  // Rejects Mind platform addresses — Mind-to-Mind Circle membership is not a supported
  // builder workflow.
  assertHumanCollaboratorEmail(email);

  const campaign = await prisma.campaign.findUnique({
    where: { id: input.campaignId },
    include: { approvedPartner: true },
  });
  if (!campaign) throw new Error(`Campaign ${input.campaignId} not found.`);
  if (!campaign.approvedPartnerId) {
    throw new CreatorApprovalMissingError("a partner selection");
  }

  // Verify the approval exists in the database rather than trusting campaign state alone.
  const approval = await prisma.approval.findFirst({
    where: {
      campaignId: campaign.id,
      actionType: ApprovalActionType.partner_selection,
      status: ApprovalStatus.approved,
    },
  });
  if (!approval) throw new CreatorApprovalMissingError("a partner selection");

  const mindId = env.MINDS_MIND_ID || "(unconfigured)";
  const correlationId = newCorrelationId();

  await prisma.circleMembership.upsert({
    where: {
      campaignId_collaboratorEmail: { campaignId: campaign.id, collaboratorEmail: email },
    },
    create: {
      campaignId: campaign.id,
      mindId,
      collaboratorEmail: email,
      status: CircleMembershipStatus.pending,
    },
    update: { status: CircleMembershipStatus.pending, mindId },
  });

  const actionId = await beginAction({
    campaignId: campaign.id,
    correlationId,
    actionType: "circle.add",
    summary: `Add approved collaborator to the Mind's trusted Circle`,
    reason:
      `Collaborator address is supplied by server configuration, never by browser input. ` +
      `Creator approval for ${campaign.approvedPartner?.name ?? "the partner"} verified.`,
  });

  try {
    await markAttempted(actionId);

    const result = await port.addCircleMember(email);

    await prisma.circleMembership.update({
      where: {
        campaignId_collaboratorEmail: { campaignId: campaign.id, collaboratorEmail: email },
      },
      data: {
        status:
          result.outcome === "already_member"
            ? CircleMembershipStatus.already_member
            : CircleMembershipStatus.active,
        addedAt: new Date(),
        removedAt: null,
        externalReference: result.reference.slice(0, 1000),
      },
    });

    await markSucceeded(actionId, {
      externalReference: result.reference,
      summary:
        result.outcome === "already_member"
          ? `Collaborator was already in the Mind's Circle (idempotent success)`
          : `Collaborator added to the Mind's trusted Circle`,
    });

    return {
      status: result.outcome,
      collaboratorEmail: email,
      memberCount: result.members.length,
      reference: result.reference,
    };
  } catch (error) {
    // Record the failure and leave the stored status as `failed`. The caller must not
    // advance the campaign to `circle_added`.
    await prisma.circleMembership.update({
      where: {
        campaignId_collaboratorEmail: { campaignId: campaign.id, collaboratorEmail: email },
      },
      data: { status: CircleMembershipStatus.failed },
    });

    await markFailed(actionId, error);
    throw error;
  }
}

export interface CircleRemoveOutcome {
  status: "removed" | "not_a_member";
  collaboratorEmail: string;
  memberCount: number;
}

/**
 * Removes the collaborator after completion or cancellation.
 *
 * §18 lists removing access as approval-required when the intended person is ambiguous.
 * There is no ambiguity here — the address is the one CollabOS itself added, read from
 * configuration — so this runs without a further gate, and is audited either way.
 */
export async function removeCollaboratorFromCircle(input: {
  campaignId: string;
  reason: string;
  port?: MindsPort;
}): Promise<CircleRemoveOutcome> {
  const env = loadEnv();
  const port = input.port ?? getMindsPort();

  const email = env.COLLABORATOR_TEST_EMAIL.trim().toLowerCase();
  if (!email) throw new CollaboratorNotConfiguredError();

  const correlationId = newCorrelationId();
  const actionId = await beginAction({
    campaignId: input.campaignId,
    correlationId,
    actionType: "circle.remove",
    summary: `Remove collaborator from the Mind's Circle`,
    reason: input.reason,
  });

  try {
    await markAttempted(actionId);

    const result = await port.removeCircleMember(email);

    await prisma.circleMembership.updateMany({
      where: { campaignId: input.campaignId, collaboratorEmail: email },
      data: { status: CircleMembershipStatus.removed, removedAt: new Date() },
    });

    await markSucceeded(actionId, {
      externalReference: result.reference,
      summary:
        result.outcome === "removed"
          ? `Collaborator removed from the Mind's Circle`
          : `Collaborator was not in the Circle (idempotent no-op)`,
    });

    return {
      status: result.outcome,
      collaboratorEmail: email,
      memberCount: result.members.length,
    };
  } catch (error) {
    await markFailed(actionId, error);
    throw error;
  }
}

export interface CircleStateView {
  configured: boolean;
  /** Null when the Circle could not be read. Never a guess. */
  members: Array<{ email: string; isSteward: boolean }> | null;
  error: string | null;
}

/** Reads live Circle state for the UI, degrading honestly on failure. */
export async function readCircleState(port?: MindsPort): Promise<CircleStateView> {
  const active = port ?? getMindsPort();

  if (!active.isConfigured()) {
    return { configured: false, members: null, error: "Mind not connected" };
  }

  try {
    const members = await active.getCircle();
    return {
      configured: true,
      members: members.map((member) => ({
        email: member.email ?? "(unknown)",
        isSteward: member.isSteward === true,
      })),
      error: null,
    };
  } catch (error) {
    const typed =
      error instanceof CollabOsMindsError
        ? error
        : new CollabOsMindsError({
            code: "MINDS_UNKNOWN",
            message: error instanceof Error ? error.message : String(error),
          });
    return { configured: true, members: null, error: typed.message };
  }
}
