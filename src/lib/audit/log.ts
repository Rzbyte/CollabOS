/**
 * Audit log.
 *
 * CLAUDE.md §3 requires that proposed / approved / attempted / succeeded / failed are
 * each independently verifiable. That is implemented with five separate nullable
 * timestamps on `AgentAction` rather than one mutable status date, because a single
 * date would overwrite history: after a failure you could no longer prove the action
 * had been attempted, nor when.
 *
 * The consequence is the property the demo depends on — a failed external call leaves
 * `attemptedAt` set and `executedAt` NULL permanently, so the Activity Log can show
 * "attempted" and "failed" as two distinct facts and can never render a failure as a
 * success.
 *
 * `toTimelineEvents()` expands each row into one entry per non-null timestamp, which
 * is what produces the chronological log in CLAUDE.md §14D.
 */
import type { AgentAction } from "../../generated/prisma/client.ts";
import { AgentActionStatus } from "../../generated/prisma/enums.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { getClock } from "../clock.ts";
import { prisma } from "../db.ts";
import { CollabOsMindsError, sanitiseErrorMessage } from "../minds/errors.ts";

export { AgentActionStatus };

/** Accepts either the root client or an interactive-transaction client. */
export type DbClient = Prisma.TransactionClient | typeof prisma;

export interface BeginActionInput {
  campaignId?: string | null;
  correlationId: string;
  actionType: string;
  /** One-line description for the Activity Log. */
  summary: string;
  reason?: string;
  requiresApproval?: boolean;
  /** True when no human is in the loop at execution time. */
  autonomous?: boolean;
  /**
   * Opt-in single-execution guarantee. A unique index means a second inserter gets a
   * constraint violation rather than a duplicate side effect.
   */
  dedupeKey?: string;
  transport?: string;
  /** Initial lifecycle state. Defaults to `proposed`. */
  status?: AgentActionStatus;
  db?: DbClient;
}

/**
 * Opens an audit record.
 *
 * Call this BEFORE performing the work, so an action that crashes mid-flight still
 * leaves evidence that it was started.
 */
export async function beginAction(input: BeginActionInput): Promise<string> {
  const db = input.db ?? prisma;
  const now = getClock().now();
  const status = input.status ?? AgentActionStatus.proposed;

  const action = await db.agentAction.create({
    data: {
      campaignId: input.campaignId ?? null,
      correlationId: input.correlationId,
      actionType: input.actionType,
      summary: input.summary,
      reason: input.reason ?? null,
      status,
      requiresApproval: input.requiresApproval ?? false,
      autonomous: input.autonomous ?? false,
      dedupeKey: input.dedupeKey ?? null,
      transport: input.transport ?? null,
      proposedAt: now,
      // An action created directly in `attempted` records both facts at once.
      attemptedAt: status === AgentActionStatus.attempted ? now : null,
    },
    select: { id: true },
  });

  return action.id;
}

/**
 * Like `beginAction`, but returns `null` instead of throwing when `dedupeKey` is
 * already taken.
 *
 * This is the concurrency primitive behind "at most one autonomous follow-up": two
 * workers racing on the same campaign both attempt the insert, Postgres admits
 * exactly one, and the loser stands down cleanly.
 */
export async function claimAction(
  input: BeginActionInput & { dedupeKey: string },
): Promise<string | null> {
  try {
    return await beginAction(input);
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}

/** Postgres unique-constraint violation, surfaced by Prisma as P2002. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export async function markApproved(
  actionId: string,
  options?: { db?: DbClient },
): Promise<void> {
  const db = options?.db ?? prisma;
  await db.agentAction.update({
    where: { id: actionId },
    data: { status: AgentActionStatus.approved, approvedAt: getClock().now() },
  });
}

export async function markRejected(
  actionId: string,
  options?: { db?: DbClient },
): Promise<void> {
  const db = options?.db ?? prisma;
  await db.agentAction.update({
    where: { id: actionId },
    data: { status: AgentActionStatus.rejected, failedAt: getClock().now() },
  });
}

/** Records that execution has started — written before the external call. */
export async function markAttempted(
  actionId: string,
  options?: { db?: DbClient; transport?: string },
): Promise<void> {
  const db = options?.db ?? prisma;
  await db.agentAction.update({
    where: { id: actionId },
    data: {
      status: AgentActionStatus.attempted,
      attemptedAt: getClock().now(),
      ...(options?.transport ? { transport: options.transport } : {}),
    },
  });
}

/** Records confirmed success. Only ever called after the side effect is verified. */
export async function markSucceeded(
  actionId: string,
  options?: { db?: DbClient; externalReference?: string; transport?: string; summary?: string },
): Promise<void> {
  const db = options?.db ?? prisma;
  await db.agentAction.update({
    where: { id: actionId },
    data: {
      status: AgentActionStatus.succeeded,
      executedAt: getClock().now(),
      ...(options?.externalReference
        ? { externalReference: options.externalReference.slice(0, 1000) }
        : {}),
      ...(options?.transport ? { transport: options.transport } : {}),
      ...(options?.summary ? { summary: options.summary } : {}),
    },
  });
}

/**
 * Records failure with a sanitised message.
 *
 * `attemptedAt` is left untouched, which is what preserves the distinction between
 * "we tried and it failed" and "we never tried".
 */
export async function markFailed(
  actionId: string,
  error: unknown,
  options?: { db?: DbClient },
): Promise<void> {
  const db = options?.db ?? prisma;
  const { errorCode, message } = describeError(error);

  await db.agentAction.update({
    where: { id: actionId },
    data: {
      status: AgentActionStatus.failed,
      failedAt: getClock().now(),
      errorCode,
      sanitisedErrorMessage: message,
    },
  });
}

export async function markSkipped(
  actionId: string,
  reason: string,
  options?: { db?: DbClient },
): Promise<void> {
  const db = options?.db ?? prisma;
  await db.agentAction.update({
    where: { id: actionId },
    data: {
      status: AgentActionStatus.skipped,
      reason: sanitiseErrorMessage(reason).slice(0, 500),
    },
  });
}

/**
 * Records a human approval decision.
 *
 * Deliberately separate from the execution lifecycle. An approval is not an "attempt" and
 * has no "execution" — the decision IS the event — so this writes `proposedAt` plus
 * `approvedAt`/`failedAt` and never touches `attemptedAt`/`executedAt`.
 *
 * Routing approvals through `markSucceeded` instead produced an incoherent audit summary
 * where succeeded counts exceeded attempted counts, because `executedAt` was set on rows
 * that had never been attempted. Keeping the two lifecycles distinct fixes that at the
 * source rather than papering over it in the report.
 */
export async function logApproval(input: {
  campaignId?: string | null;
  correlationId: string;
  actionType: string;
  summary: string;
  reason?: string;
  decision: "approved" | "rejected";
  db?: DbClient;
}): Promise<string> {
  const db = input.db ?? prisma;
  const now = getClock().now();
  const approved = input.decision === "approved";

  const action = await db.agentAction.create({
    data: {
      campaignId: input.campaignId ?? null,
      correlationId: input.correlationId,
      actionType: input.actionType,
      summary: input.summary,
      reason: input.reason ?? null,
      status: approved ? AgentActionStatus.approved : AgentActionStatus.rejected,
      requiresApproval: true,
      autonomous: false,
      proposedAt: now,
      ...(approved ? { approvedAt: now } : { failedAt: now }),
    },
    select: { id: true },
  });

  return action.id;
}

/**
 * One-shot record for work that completes atomically (loading memory, creating a
 * brief). Written straight to `succeeded`.
 */
export async function logEvent(
  input: Omit<BeginActionInput, "status"> & { externalReference?: string },
): Promise<string> {
  const db = input.db ?? prisma;
  const now = getClock().now();

  const action = await db.agentAction.create({
    data: {
      campaignId: input.campaignId ?? null,
      correlationId: input.correlationId,
      actionType: input.actionType,
      summary: input.summary,
      reason: input.reason ?? null,
      status: AgentActionStatus.succeeded,
      requiresApproval: input.requiresApproval ?? false,
      autonomous: input.autonomous ?? false,
      dedupeKey: input.dedupeKey ?? null,
      transport: input.transport ?? null,
      externalReference: input.externalReference ?? null,
      proposedAt: now,
      attemptedAt: now,
      executedAt: now,
    },
    select: { id: true },
  });

  return action.id;
}

/** Extracts a stable code plus a credential-free message from any thrown value. */
export function describeError(error: unknown): { errorCode: string; message: string } {
  if (error instanceof CollabOsMindsError) {
    const fields = error.toAuditFields();
    return { errorCode: fields.errorCode, message: fields.sanitisedErrorMessage };
  }

  if (error instanceof Error) {
    const code =
      "code" in error && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : error.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    return {
      errorCode: code.slice(0, 100),
      message: sanitiseErrorMessage(error.message).slice(0, 500),
    };
  }

  return {
    errorCode: "UNKNOWN_ERROR",
    message: sanitiseErrorMessage(String(error)).slice(0, 500),
  };
}

// ---------------------------------------------------------------------------
// Timeline projection
// ---------------------------------------------------------------------------

export type TimelinePhase =
  | "proposed"
  | "approved"
  | "attempted"
  | "succeeded"
  | "failed";

export interface TimelineEvent {
  actionId: string;
  correlationId: string;
  actionType: string;
  phase: TimelinePhase;
  at: Date;
  summary: string;
  autonomous: boolean;
  requiresApproval: boolean;
  transport: string | null;
  errorCode: string | null;
  sanitisedErrorMessage: string | null;
}

const PHASE_PREFIX: Record<TimelinePhase, string> = {
  proposed: "Proposed",
  approved: "Approved",
  attempted: "Attempted",
  succeeded: "Succeeded",
  failed: "Failed",
};

/**
 * Expands audit rows into a flat chronological timeline, one entry per recorded
 * lifecycle timestamp.
 *
 * A single Circle addition therefore renders as up to three separate lines
 * ("Proposed", "Attempted", "Succeeded"), which is exactly the evidence §14D asks
 * for. Ties are broken by phase order so "Attempted" never sorts after "Succeeded"
 * when both share a timestamp.
 */
export function toTimelineEvents(actions: AgentAction[]): TimelineEvent[] {
  const phaseOrder: TimelinePhase[] = [
    "proposed",
    "approved",
    "attempted",
    "succeeded",
    "failed",
  ];

  const events: TimelineEvent[] = [];

  for (const action of actions) {
    const stamps: Array<[TimelinePhase, Date | null]> = [
      ["proposed", action.proposedAt],
      ["approved", action.approvedAt],
      ["attempted", action.attemptedAt],
      ["succeeded", action.executedAt],
      ["failed", action.failedAt],
    ];

    for (const [phase, at] of stamps) {
      if (!at) continue;

      events.push({
        actionId: action.id,
        correlationId: action.correlationId,
        actionType: action.actionType,
        phase,
        at,
        summary: `${PHASE_PREFIX[phase]} — ${action.summary}`,
        autonomous: action.autonomous,
        requiresApproval: action.requiresApproval,
        transport: action.transport,
        errorCode: phase === "failed" ? action.errorCode : null,
        sanitisedErrorMessage: phase === "failed" ? action.sanitisedErrorMessage : null,
      });
    }
  }

  return events.sort((a, b) => {
    const delta = a.at.getTime() - b.at.getTime();
    if (delta !== 0) return delta;
    return phaseOrder.indexOf(a.phase) - phaseOrder.indexOf(b.phase);
  });
}
