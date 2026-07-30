"use server";

/**
 * Server actions.
 *
 * These are the only bridge from the browser into CollabOS's domain logic. They validate
 * input with Zod, delegate to the campaign service, and translate thrown domain errors
 * into displayable state.
 *
 * Note what is NOT here: no action writes `campaign.status`. Every state change goes
 * through the transition service (CLAUDE.md §12), so a malformed or malicious request
 * cannot move a campaign into an illegal state.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  ActiveCampaignExistsError,
  NoCreatorProfileError,
  approvePartner,
  cancelCampaign,
  rejectPartner,
  retryRecommendations,
  submitObjective,
} from "../lib/campaign/service.ts";
import {
  advanceAfterAcceptance,
  approveAndSendOutreach,
} from "../lib/campaign/collaboration.ts";
import { approveDeliverable, rejectDeliverable } from "../lib/campaign/completion.ts";
import {
  CollaboratorNotConfiguredError,
  CreatorApprovalMissingError,
  removeCollaboratorFromCircle,
} from "../lib/circle/service.ts";
import { EmailTransportError } from "../lib/email/transport.ts";
import { CollabOsMindsError } from "../lib/minds/errors.ts";
import {
  BrandSafetyViolationError,
  PartnerContactBlockedError,
} from "../lib/safety/brand-safety.ts";
import { IllegalTransitionError } from "../lib/campaign/states.ts";
import { CampaignStateConflictError } from "../lib/campaign/transition.ts";

// `ActionState` and `IDLE` live in ./action-state.ts — a "use server" module may only export
// async functions, so the runtime constant cannot be re-exported from here.
import type { ActionState } from "./action-state.ts";

const ObjectiveSchema = z.object({
  objective: z
    .string()
    .trim()
    .min(10, "Describe the growth objective in at least 10 characters.")
    .max(600, "Keep the objective under 600 characters."),
});

const PartnerDecisionSchema = z.object({
  campaignId: z.string().min(1),
  partnerId: z.string().min(1),
  note: z.string().max(500).optional(),
});

/**
 * Maps domain errors to creator-facing messages.
 *
 * Domain errors carry deliberately actionable text, so they are surfaced as-is. Unknown
 * errors are reported generically — an unexpected stack trace must not leak to the
 * browser.
 */
function describeFailure(error: unknown): ActionState {
  if (
    error instanceof BrandSafetyViolationError ||
    error instanceof PartnerContactBlockedError ||
    error instanceof IllegalTransitionError ||
    error instanceof CampaignStateConflictError ||
    error instanceof ActiveCampaignExistsError ||
    error instanceof NoCreatorProfileError ||
    error instanceof CollaboratorNotConfiguredError ||
    error instanceof CreatorApprovalMissingError ||
    error instanceof EmailTransportError
  ) {
    return { status: "error", message: error.message, code: error.code };
  }

  if (error instanceof CollabOsMindsError) {
    return { status: "error", message: error.message, code: error.code };
  }

  if (error instanceof z.ZodError) {
    return {
      status: "error",
      message: error.issues[0]?.message ?? "Invalid input.",
      code: "VALIDATION_ERROR",
    };
  }

  if (error instanceof Error) {
    return { status: "error", message: error.message, code: "ERROR" };
  }

  console.error("Unexpected action failure:", error);
  return {
    status: "error",
    message: "Something went wrong. Check the server logs.",
    code: "UNKNOWN",
  };
}

function refresh(): void {
  revalidatePath("/");
  revalidatePath("/partners");
  revalidatePath("/activity");
  revalidatePath("/room");
}

export async function submitObjectiveAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { objective } = ObjectiveSchema.parse({
      objective: formData.get("objective"),
    });

    const result = await submitObjective({ objective });
    refresh();

    if (!result.recommended) {
      return {
        status: "error",
        // The campaign exists and is recoverable — say so rather than implying total loss.
        message:
          `Objective saved, but the Mind could not produce recommendations. ` +
          `${result.error?.message ?? ""} The failure is recorded in the activity log; ` +
          `use "Retry evaluation" once the issue is resolved.`,
        code: result.error?.code ?? "MIND_FAILED",
      };
    }

    const overrideNote = result.overrides?.length
      ? ` Brand-safety override applied to ${result.overrides.join(", ")}.`
      : "";

    return {
      status: "success",
      message: `Candidates evaluated and ready for review.${overrideNote}`,
    };
  } catch (error) {
    return describeFailure(error);
  }
}

export async function retryRecommendationsAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const campaignId = z.string().min(1).parse(formData.get("campaignId"));
    const result = await retryRecommendations({ campaignId });
    refresh();

    if (!result.recommended) {
      return {
        status: "error",
        message: result.error?.message ?? "Evaluation failed again.",
        code: result.error?.code ?? "MIND_FAILED",
      };
    }

    return { status: "success", message: "Candidates re-evaluated." };
  } catch (error) {
    return describeFailure(error);
  }
}

export async function approvePartnerAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const input = PartnerDecisionSchema.parse({
      campaignId: formData.get("campaignId"),
      partnerId: formData.get("partnerId"),
    });

    await approvePartner(input);
    refresh();

    return {
      status: "success",
      message:
        "Partner approved. Outreach still requires your separate approval before " +
        "anything is sent.",
    };
  } catch (error) {
    return describeFailure(error);
  }
}

export async function rejectPartnerAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const noteRaw = formData.get("note");
    const input = PartnerDecisionSchema.parse({
      campaignId: formData.get("campaignId"),
      partnerId: formData.get("partnerId"),
      ...(typeof noteRaw === "string" && noteRaw.length > 0 ? { note: noteRaw } : {}),
    });

    await rejectPartner(input);
    refresh();

    return { status: "success", message: "Partner rejected and recorded." };
  } catch (error) {
    return describeFailure(error);
  }
}

export async function cancelCampaignAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const campaignId = z.string().min(1).parse(formData.get("campaignId"));
    await cancelCampaign({ campaignId, reason: "Cancelled from the Command Center." });
    refresh();
    return { status: "success", message: "Campaign cancelled." };
  } catch (error) {
    return describeFailure(error);
  }
}

/**
 * The second human gate: authorises the FIRST external contact.
 *
 * Separate from partner approval on purpose — §18 treats first outreach as its own
 * decision, so approving a partner never implies permission to message them.
 */
export async function approveOutreachAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const campaignId = z.string().min(1).parse(formData.get("campaignId"));
    const result = await approveAndSendOutreach({ campaignId });
    refresh();

    if (!result.ok) {
      return {
        status: "error",
        message:
          `Outreach was authorised but could not be sent. ${result.error?.message ?? ""} ` +
          `The failure is recorded in the activity log; use "Retry" to try again.`,
        code: result.error?.code ?? "OUTREACH_FAILED",
      };
    }

    return {
      status: "success",
      message:
        "Outreach sent through the local test transport (Mailpit). Open " +
        "http://localhost:8025 to read it and follow the acceptance link.",
    };
  } catch (error) {
    return describeFailure(error);
  }
}

/** Resumes the Circle → brief → deliverable pump after a partial failure. */
export async function retryAdvanceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const campaignId = z.string().min(1).parse(formData.get("campaignId"));
    const result = await advanceAfterAcceptance({ campaignId });
    refresh();

    if (!result.ok) {
      return {
        status: "error",
        message: result.error?.message ?? "Could not advance the campaign.",
        code: result.error?.code ?? "ADVANCE_FAILED",
      };
    }

    return {
      status: "success",
      message: result.steps.length
        ? `Advanced: ${result.steps.join(", ")}.`
        : "Nothing left to advance.",
    };
  } catch (error) {
    return describeFailure(error);
  }
}

/**
 * The final human gate: creator approves the finished work and the campaign completes.
 *
 * `performance` is optional and explicitly CREATOR-REPORTED. CollabOS has no analytics
 * integration, so it never infers an audience figure — a blank field stays blank rather than
 * becoming a fabricated number.
 */
export async function approveDeliverableAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const campaignId = z.string().min(1).parse(formData.get("campaignId"));

    const raw = formData.get("performance");
    const performance =
      typeof raw === "string" && raw.trim() !== ""
        ? z.coerce.number().min(0).max(1).parse(raw)
        : null;

    const result = await approveDeliverable({ campaignId, creatorReportedPerformance: performance });
    refresh();

    const debriefNote = result.debriefRecorded
      ? " The Mind recorded a debrief for future partner choices."
      : ` The campaign completed, but the Mind debrief was unavailable (${result.error?.code ?? "unknown"}) — recorded as a failure, not invented.`;

    return {
      status: "success",
      message: `Campaign completed and relationship memory updated.${debriefNote}`,
    };
  } catch (error) {
    return describeFailure(error);
  }
}

/** Sends the deliverable back for a revision round. */
export async function rejectDeliverableAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const campaignId = z.string().min(1).parse(formData.get("campaignId"));
    const note = z
      .string()
      .trim()
      .min(3, "Tell the collaborator what needs changing.")
      .max(500)
      .parse(formData.get("note"));

    await rejectDeliverable({ campaignId, note });
    refresh();

    return {
      status: "success",
      message:
        "Revision requested. The collaborator can submit again from their link. No second " +
        "autonomous reminder will be sent — one has already been used.",
    };
  } catch (error) {
    return describeFailure(error);
  }
}

/** Removes the collaborator from the Circle after the campaign has ended. */
export async function removeFromCircleAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const campaignId = z.string().min(1).parse(formData.get("campaignId"));
    const result = await removeCollaboratorFromCircle({
      campaignId,
      reason: "Removed from the Collaboration Room after the campaign ended.",
    });
    refresh();

    return {
      status: "success",
      message:
        result.status === "removed"
          ? "Collaborator removed from the Mind's Circle."
          : "Collaborator was not in the Circle — nothing to remove.",
    };
  } catch (error) {
    return describeFailure(error);
  }
}
