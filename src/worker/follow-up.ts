/**
 * Autonomous follow-up worker (CLAUDE.md §15).
 *
 * This is the component that makes the autonomy claim true rather than staged. It runs as a
 * SEPARATE PROCESS (`npm run worker`), polls `nextActionAt`, and sends at most one
 * contextual follow-up per campaign. There is no "Follow Up" button anywhere in the UI —
 * deliberately, because a button would prove nothing.
 *
 * Concurrency and safety are layered, because "at most one follow-up" has to survive two
 * workers racing, a crashed worker, and a transient failure that deserves a retry:
 *
 *   1. **Lease claim** — `SELECT … FOR UPDATE SKIP LOCKED` plus a `lockedUntil` expiry gives
 *      one worker exclusive use of a campaign. SKIP LOCKED means a second worker moves on
 *      instead of blocking; the expiry means a crashed worker's claim frees itself rather
 *      than wedging the campaign forever.
 *   2. **`followUpCount` compare-and-swap** — the hard cap. Incremented in the same
 *      transaction as the `follow_up_sent` transition, conditional on it still being 0.
 *   3. **Unique `dedupeKey`** — a success marker written in that same transaction. Postgres
 *      rejects a second one, so a duplicate *successful* send cannot be recorded even if
 *      layers 1 and 2 were both defeated.
 *
 * Failed attempts are recorded WITHOUT a dedupeKey, which is what keeps retries possible
 * while a successful send closes the door permanently.
 *
 * Every timestamp comparison goes through the injectable clock, so tests prove the overdue
 * behaviour without waiting three real minutes.
 */
import { DeliverableStatus } from "../generated/prisma/enums.ts";
import { OutboundMessageKind } from "../generated/prisma/enums.ts";
import {
  AgentActionStatus,
  beginAction,
  logEvent,
  markAttempted,
  markFailed,
  markSucceeded,
} from "../lib/audit/log.ts";
import { getClock, type Clock } from "../lib/clock.ts";
import { isPartnerRejectedForCampaign } from "../lib/campaign/service.ts";
import { CampaignStatus } from "../lib/campaign/states.ts";
import { transitionCampaign } from "../lib/campaign/transition.ts";
import { prisma } from "../lib/db.ts";
import { getEmailTransport, type EmailTransport } from "../lib/email/transport.ts";
import { getMindsPort, newCorrelationId, type MindsPort } from "../lib/minds/client.ts";
import { toCollabOsMindsError } from "../lib/minds/errors.ts";
import { buildFollowUpPrompt } from "../lib/minds/prompts.ts";
import { requestFollowUpMessage } from "../lib/minds/reasoning.ts";

/** How long a worker holds a claim before it is considered dead. */
const LEASE_SECONDS = 120;
/** Bounded retries: give up rescheduling after this many failed attempts. */
export const MAX_FOLLOW_UP_ATTEMPTS = 3;
/** Backoff before retrying a failed follow-up. */
const RETRY_BACKOFF_SECONDS = 60;
/** Campaigns considered per pass. */
const BATCH_SIZE = 10;

/** States in which an overdue deliverable may legitimately trigger a follow-up. */
const ELIGIBLE_STATES: CampaignStatus[] = [
  CampaignStatus.awaiting_deliverable,
  CampaignStatus.follow_up_due,
];

export interface WorkerDeps {
  port?: MindsPort;
  transport?: EmailTransport;
  clock?: Clock;
  /** Identifies the lease holder; useful when debugging two workers. */
  workerId?: string;
}

export type CampaignOutcome =
  | "sent"
  | "skipped_not_eligible"
  | "skipped_already_followed_up"
  | "skipped_not_overdue"
  | "skipped_partner_unavailable"
  | "skipped_claimed_elsewhere"
  | "skipped_attempts_exhausted"
  | "failed";

export interface CampaignResult {
  campaignId: string;
  outcome: CampaignOutcome;
  detail: string;
}

export interface PassResult {
  claimed: number;
  results: CampaignResult[];
}

function dedupeKeyFor(campaignId: string): string {
  return `followup:v1:${campaignId}`;
}

/**
 * Claims due campaigns with `FOR UPDATE SKIP LOCKED`.
 *
 * The select and the lease write happen in one transaction so no other worker can observe
 * an unclaimed-but-about-to-be-claimed row.
 */
export async function claimDueCampaigns(deps: WorkerDeps = {}): Promise<string[]> {
  const clock = deps.clock ?? getClock();
  const now = clock.now();
  const workerId = deps.workerId ?? `worker-${process.pid}`;
  const leaseUntil = new Date(now.getTime() + LEASE_SECONDS * 1000);

  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "Campaign"
      WHERE "nextActionAt" IS NOT NULL
        AND "nextActionAt" <= ${now}
        AND "status"::text = ANY(${ELIGIBLE_STATES})
        AND ("lockedUntil" IS NULL OR "lockedUntil" < ${now})
      ORDER BY "nextActionAt" ASC
      LIMIT ${BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    `;

    const ids = rows.map((row) => row.id);
    if (ids.length === 0) return [];

    await tx.campaign.updateMany({
      where: { id: { in: ids } },
      data: { lockedBy: workerId, lockedUntil: leaseUntil },
    });

    return ids;
  });
}

async function releaseClaim(campaignId: string): Promise<void> {
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { lockedBy: null, lockedUntil: null },
  });
}

/** One full pass: claim due work, process it, release the claims. */
export async function runFollowUpPass(deps: WorkerDeps = {}): Promise<PassResult> {
  const ids = await claimDueCampaigns(deps);
  const results: CampaignResult[] = [];

  for (const campaignId of ids) {
    try {
      results.push(await processClaimedCampaign(campaignId, deps));
    } catch (error) {
      results.push({
        campaignId,
        outcome: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await releaseClaim(campaignId);
    }
  }

  return { claimed: ids.length, results };
}

/**
 * Processes one campaign the caller already holds a lease on.
 *
 * Guards run in cheapest-first order, and every stand-down reason is distinct so the audit
 * log explains exactly why a follow-up did or did not happen.
 */
export async function processClaimedCampaign(
  campaignId: string,
  deps: WorkerDeps = {},
): Promise<CampaignResult> {
  const clock = deps.clock ?? getClock();
  const port = deps.port ?? getMindsPort();
  const transport = deps.transport ?? getEmailTransport();
  const now = clock.now();
  const correlationId = newCorrelationId();

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: {
      creator: true,
      approvedPartner: true,
      deliverables: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!campaign) {
    return { campaignId, outcome: "skipped_not_eligible", detail: "campaign not found" };
  }

  // --- guard: still awaiting the action we think it is -----------------------
  if (!ELIGIBLE_STATES.includes(campaign.status)) {
    await clearSchedule(campaignId);
    return {
      campaignId,
      outcome: "skipped_not_eligible",
      detail: `state is ${campaign.status}`,
    };
  }

  // --- guard: at most one autonomous follow-up ------------------------------
  if (campaign.followUpCount > 0) {
    await clearSchedule(campaignId);
    return {
      campaignId,
      outcome: "skipped_already_followed_up",
      detail: `followUpCount is ${campaign.followUpCount}`,
    };
  }

  const partner = campaign.approvedPartner;
  const deliverable = campaign.deliverables[0];

  if (!partner || !deliverable) {
    await clearSchedule(campaignId);
    return {
      campaignId,
      outcome: "skipped_not_eligible",
      detail: "no approved partner or deliverable",
    };
  }

  // --- guard: actually overdue ---------------------------------------------
  if (!deliverable.dueAt || deliverable.dueAt > now) {
    return {
      campaignId,
      outcome: "skipped_not_overdue",
      detail: `due at ${deliverable.dueAt?.toISOString() ?? "(unset)"}`,
    };
  }

  if (deliverable.status === DeliverableStatus.submitted || deliverable.submittedAt) {
    await clearSchedule(campaignId);
    return {
      campaignId,
      outcome: "skipped_not_eligible",
      detail: "deliverable already submitted",
    };
  }

  // --- guard: partner has not opted out or been rejected -------------------
  const relationship = await prisma.relationship.findUnique({
    where: {
      creatorId_partnerId: { creatorId: campaign.creatorId, partnerId: partner.id },
    },
  });

  if (relationship?.optedOut || (await isPartnerRejectedForCampaign(campaign.id, partner.id))) {
    await clearSchedule(campaignId);
    await logEvent({
      campaignId,
      correlationId,
      actionType: "followup.suppressed",
      summary: `Follow-up suppressed — ${partner.name} must not be contacted`,
      autonomous: true,
      reason: relationship?.optedOut
        ? "Partner has opted out of outreach."
        : "Creator rejected this partner for this campaign.",
    });
    return {
      campaignId,
      outcome: "skipped_partner_unavailable",
      detail: relationship?.optedOut ? "partner opted out" : "partner rejected by creator",
    };
  }

  // --- guard: bounded retries ---------------------------------------------
  const priorFailures = await prisma.agentAction.count({
    where: {
      campaignId,
      actionType: "followup.send",
      status: AgentActionStatus.failed,
    },
  });

  if (priorFailures >= MAX_FOLLOW_UP_ATTEMPTS) {
    await clearSchedule(campaignId);
    await logEvent({
      campaignId,
      correlationId,
      actionType: "followup.abandoned",
      summary:
        `Autonomous follow-up abandoned after ${priorFailures} failed attempts — ` +
        `no further retries will be scheduled`,
      autonomous: true,
      reason:
        "Bounded retries exhausted. The collaborator can still submit; nothing was sent.",
    });
    return {
      campaignId,
      outcome: "skipped_attempts_exhausted",
      detail: `${priorFailures} prior failures`,
    };
  }

  // --- the deliverable is genuinely overdue: begin -------------------------
  if (campaign.status === CampaignStatus.awaiting_deliverable) {
    await transitionCampaign({
      campaignId,
      to: CampaignStatus.follow_up_due,
      actionType: "campaign.follow_up_due",
      summary: `Deliverable became overdue — autonomous follow-up is due`,
      correlationId,
      autonomous: true,
      expectedFrom: [CampaignStatus.awaiting_deliverable],
    });
  }

  await transitionCampaign({
    campaignId,
    to: CampaignStatus.follow_up_generating,
    actionType: "campaign.follow_up_generating",
    summary: `Autonomous follow-up generation started`,
    correlationId,
    autonomous: true,
    expectedFrom: [CampaignStatus.follow_up_due],
  });

  const actionId = await beginAction({
    campaignId,
    correlationId,
    actionType: "followup.send",
    summary: `Compose and send one autonomous follow-up to ${partner.name}`,
    autonomous: true,
    transport: transport.name,
    reason:
      `Deliverable "${deliverable.title}" passed its agreed deadline. This is the single ` +
      `pre-authorised reminder — not new outreach.`,
  });

  try {
    await markAttempted(actionId, { transport: transport.name });

    await port.ensureConversation(campaign.creator.mindConversationAlias);

    const message = await requestFollowUpMessage({
      port,
      alias: campaign.creator.mindConversationAlias,
      campaignId,
      correlationId,
      prompt: buildFollowUpPrompt({
        creator: campaign.creator,
        partner,
        relationship,
        objective: campaign.objective,
        deliverableTitle: deliverable.title,
        deliverableDescription: deliverable.description,
        dueAt: deliverable.dueAt,
        now,
      }),
    });

    const sent = await transport.send({
      to: partner.email,
      subject: message.value.subject,
      body: message.value.body,
      fromName: campaign.creator.name,
    });

    // ---- commit point: cap, transition, and success marker together --------
    // The CAS on followUpCount plus the unique dedupeKey mean a second successful send can
    // neither be performed nor recorded.
    const claimed = await prisma.campaign.updateMany({
      where: { id: campaignId, followUpCount: 0 },
      data: { followUpCount: 1 },
    });

    if (claimed.count === 0) {
      await markFailed(
        actionId,
        new Error("Another worker recorded a follow-up first; standing down."),
      );
      return {
        campaignId,
        outcome: "skipped_claimed_elsewhere",
        detail: "followUpCount was already incremented",
      };
    }

    await prisma.outboundMessage.create({
      data: {
        campaignId,
        kind: OutboundMessageKind.follow_up,
        transport: sent.transport,
        toEmail: partner.email,
        subject: message.value.subject,
        body: message.value.body,
        sentAt: now,
        externalReference: sent.externalReference,
      },
    });

    await markSucceeded(actionId, {
      externalReference: sent.externalReference,
      transport: sent.transport,
      summary: `Autonomous follow-up sent to ${partner.name} via ${transport.label}`,
    });

    // Database-level proof that exactly one follow-up completed.
    await prisma.agentAction.create({
      data: {
        campaignId,
        correlationId,
        actionType: "followup.completed",
        summary: `Follow-up delivered to ${partner.name} — one only, no further reminders`,
        status: AgentActionStatus.succeeded,
        autonomous: true,
        transport: sent.transport,
        dedupeKey: dedupeKeyFor(campaignId),
        proposedAt: now,
        attemptedAt: now,
        executedAt: now,
      },
    });

    await transitionCampaign({
      campaignId,
      to: CampaignStatus.follow_up_sent,
      actionType: "campaign.follow_up_sent",
      summary: `Follow-up sent through ${transport.label}`,
      correlationId,
      autonomous: true,
      expectedFrom: [CampaignStatus.follow_up_generating],
      // Nothing further is scheduled: this was the only reminder.
      campaignData: { nextActionAt: null },
    });

    return {
      campaignId,
      outcome: "sent",
      detail: `subject "${message.value.subject}"`,
    };
  } catch (error) {
    await markFailed(actionId, error);

    const typed = toCollabOsMindsError(error, correlationId);
    const attemptsSoFar = priorFailures + 1;
    const exhausted = attemptsSoFar >= MAX_FOLLOW_UP_ATTEMPTS;

    // Back out to `awaiting_deliverable` so a later pass can retry, and reschedule with
    // backoff unless the retry budget is spent.
    await transitionCampaign({
      campaignId,
      to: CampaignStatus.awaiting_deliverable,
      actionType: "campaign.follow_up_retry_pending",
      summary: exhausted
        ? `Follow-up failed ${attemptsSoFar} times — no further attempts will be scheduled`
        : `Follow-up attempt failed — will retry`,
      correlationId,
      autonomous: true,
      expectedFrom: [CampaignStatus.follow_up_generating],
      campaignData: {
        nextActionAt: exhausted
          ? null
          : new Date(now.getTime() + RETRY_BACKOFF_SECONDS * 1000),
      },
    });

    return { campaignId, outcome: "failed", detail: typed.message };
  }
}

async function clearSchedule(campaignId: string): Promise<void> {
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { nextActionAt: null },
  });
}
