/**
 * Campaign transition service.
 *
 * The ONLY code in CollabOS permitted to write `Campaign.status`. UI code, server
 * actions, and the worker all route through `transitionCampaign()`, which guarantees
 * that every state change is validated against the adjacency map and audited in the
 * same database transaction as the change itself. There is no path that can move a
 * campaign forward without leaving a record.
 *
 * Three behaviours worth stating explicitly:
 *
 *   • Idempotent — re-entering the current state returns `changed: false` and writes
 *     nothing, so a retried request or a double-clicked button is harmless.
 *   • Rejected when illegal — an edge absent from the map throws.
 *   • Optimistic — `expectedFrom` lets a caller assert the state it believes it saw,
 *     so a concurrent mutation is detected rather than silently overwritten.
 */
import type { Campaign } from "../../generated/prisma/client.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { type DbClient, logEvent } from "../audit/log.ts";
import { prisma } from "../db.ts";
import {
  CAMPAIGN_TRANSITIONS,
  CampaignStatus,
  IllegalTransitionError,
  STATUS_LABELS,
  canTransition,
} from "./states.ts";

/** Raised when the campaign is not in the state the caller expected. */
export class CampaignStateConflictError extends Error {
  readonly code = "CAMPAIGN_STATE_CONFLICT";
  readonly actual: CampaignStatus;
  readonly expected: readonly CampaignStatus[];

  constructor(actual: CampaignStatus, expected: readonly CampaignStatus[]) {
    super(
      `Campaign is in state "${actual}" but this operation requires one of: ` +
        `${expected.join(", ")}. Another session or the worker has likely moved it on.`,
    );
    this.name = "CampaignStateConflictError";
    this.actual = actual;
    this.expected = expected;
  }
}

export class CampaignNotFoundError extends Error {
  readonly code = "CAMPAIGN_NOT_FOUND";
  constructor(campaignId: string) {
    super(`Campaign ${campaignId} does not exist.`);
    this.name = "CampaignNotFoundError";
  }
}

export interface TransitionInput {
  campaignId: string;
  to: CampaignStatus;
  /** Stable machine-readable action name, e.g. `campaign.partner_approved`. */
  actionType: string;
  /** One-line human-readable summary for the Activity Log. */
  summary: string;
  correlationId: string;
  reason?: string;
  /** Optimistic-concurrency guard. */
  expectedFrom?: readonly CampaignStatus[];
  /** Additional campaign columns to write atomically with the status change. */
  campaignData?: Omit<Prisma.CampaignUpdateInput, "status">;
  /** True when the transition is performed autonomously by the worker. */
  autonomous?: boolean;
  /** Supply when already inside an interactive transaction. */
  db?: DbClient;
}

export interface TransitionResult {
  changed: boolean;
  from: CampaignStatus;
  to: CampaignStatus;
  campaign: Campaign;
}

/**
 * Validates and applies a state change, writing the audit row in the same
 * transaction.
 *
 * When `db` is omitted a new interactive transaction is opened, so the status update
 * and its audit entry either both land or neither does.
 */
export async function transitionCampaign(
  input: TransitionInput,
): Promise<TransitionResult> {
  if (input.db) return applyTransition(input.db, input);
  return prisma.$transaction((tx) => applyTransition(tx, input));
}

async function applyTransition(
  db: DbClient,
  input: TransitionInput,
): Promise<TransitionResult> {
  const existing = await db.campaign.findUnique({
    where: { id: input.campaignId },
  });

  if (!existing) throw new CampaignNotFoundError(input.campaignId);

  const from = existing.status;

  // Idempotency: already where we were asked to go.
  if (from === input.to) {
    return { changed: false, from, to: input.to, campaign: existing };
  }

  if (input.expectedFrom && !input.expectedFrom.includes(from)) {
    throw new CampaignStateConflictError(from, input.expectedFrom);
  }

  if (!canTransition(from, input.to)) {
    throw new IllegalTransitionError(from, input.to);
  }

  const campaign = await db.campaign.update({
    where: { id: input.campaignId },
    data: {
      ...(input.campaignData ?? {}),
      status: input.to,
    },
  });

  await logEvent({
    db,
    campaignId: campaign.id,
    correlationId: input.correlationId,
    actionType: input.actionType,
    summary: input.summary,
    reason:
      input.reason ??
      `State ${STATUS_LABELS[from]} → ${STATUS_LABELS[input.to]}`,
    autonomous: input.autonomous ?? false,
  });

  return { changed: true, from, to: input.to, campaign };
}

/**
 * Updates scheduling columns WITHOUT changing state.
 *
 * Separate from `transitionCampaign` so that "when should the worker look at this
 * next" never becomes an excuse to bypass transition validation.
 */
export async function updateCampaignSchedule(
  campaignId: string,
  data: Pick<Prisma.CampaignUpdateInput, "nextActionAt" | "deadline" | "lockedBy" | "lockedUntil">,
  options?: { db?: DbClient },
): Promise<Campaign> {
  const db = options?.db ?? prisma;
  return db.campaign.update({ where: { id: campaignId }, data });
}

/** Convenience for the UI: what could legally happen next. */
export function allowedNextStates(from: CampaignStatus): readonly CampaignStatus[] {
  return CAMPAIGN_TRANSITIONS[from];
}
