"use server";

/**
 * Collaborator-side server actions.
 *
 * These run for an UNAUTHENTICATED visitor, so the signed token is the only credential and
 * the surface is kept deliberately tiny:
 *
 *   • The campaign id comes from the verified token, never from a form field. A visitor
 *     cannot act on a campaign they were not given a link to.
 *   • No email address is accepted. The Circle addition uses the server-configured
 *     `COLLABORATOR_TEST_EMAIL`, which is what makes §16's rule hold here.
 *   • Only two operations exist: accept, and submit a deliverable.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  acceptCollaboration,
  submitDeliverable,
} from "../../lib/campaign/collaboration.ts";
import { InvalidLinkError, verifyCollaborationToken } from "../../lib/links/sign.ts";
import type { ActionState } from "../action-state.ts";

const SubmissionSchema = z.object({
  submissionUrl: z
    .string()
    .trim()
    .min(4, "Add a link or reference for your submission.")
    .max(2000),
  note: z.string().trim().max(1000).optional(),
});

function fail(error: unknown): ActionState {
  if (error instanceof InvalidLinkError) {
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
  console.error("Unexpected collaborator action failure:", error);
  return { status: "error", message: "Something went wrong.", code: "UNKNOWN" };
}

function refresh(token: string): void {
  revalidatePath(`/collab/${token}`);
  revalidatePath("/");
  revalidatePath("/room");
  revalidatePath("/activity");
}

export async function acceptCollaborationAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const token = String(formData.get("token") ?? "");

  try {
    // Identity comes from the signature, not the request body.
    const { campaignId } = verifyCollaborationToken(token);
    const result = await acceptCollaboration({ campaignId });
    refresh(token);

    if (!result.ok) {
      return {
        status: "error",
        message:
          `Your acceptance was recorded, but setup could not finish: ` +
          `${result.error?.message ?? ""} The creator has been notified through the ` +
          `activity log.`,
        code: result.error?.code ?? "SETUP_INCOMPLETE",
      };
    }

    return {
      status: "success",
      message: "Collaboration accepted. The shared brief is below.",
    };
  } catch (error) {
    return fail(error);
  }
}

export async function submitDeliverableAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const token = String(formData.get("token") ?? "");

  try {
    const { campaignId } = verifyCollaborationToken(token);
    const noteRaw = formData.get("note");

    const input = SubmissionSchema.parse({
      submissionUrl: formData.get("submissionUrl"),
      ...(typeof noteRaw === "string" && noteRaw.trim().length > 0
        ? { note: noteRaw }
        : {}),
    });

    await submitDeliverable({
      campaignId,
      submissionUrl: input.submissionUrl,
      ...(input.note ? { note: input.note } : {}),
    });

    refresh(token);

    return {
      status: "success",
      message: "Deliverable submitted. It is now awaiting the creator's final approval.",
    };
  } catch (error) {
    return fail(error);
  }
}
