/**
 * Campaign state machine definition.
 *
 * This module is pure data + pure functions — no database, no I/O — so the legal and
 * illegal transition tests are fast and exhaustive.
 *
 * The adjacency map below is the single source of truth for what a campaign may do
 * next. `src/lib/campaign/transition.ts` is the only code permitted to act on it, and
 * it is the only writer of `Campaign.status`.
 */
import { CampaignStatus } from "../../generated/prisma/enums.ts";

export { CampaignStatus };

/** States from which no further progress is possible. */
export const TERMINAL_STATES: readonly CampaignStatus[] = [
  CampaignStatus.completed,
  CampaignStatus.cancelled,
  CampaignStatus.failed,
] as const;

/**
 * States where an external system (Minds, SMTP) is involved, so a genuine failure is
 * possible and must be representable rather than swallowed.
 */
const CAN_FAIL: readonly CampaignStatus[] = [
  CampaignStatus.objective_submitted,
  CampaignStatus.outreach_approved,
  CampaignStatus.circle_add_pending,
  CampaignStatus.follow_up_generating,
] as const;

/**
 * Forward transitions, excluding the universal `cancelled` edge and the `failed`
 * edges, which are layered on below to keep this table readable.
 */
const FORWARD: Record<CampaignStatus, readonly CampaignStatus[]> = {
  [CampaignStatus.draft]: [CampaignStatus.objective_submitted],

  [CampaignStatus.objective_submitted]: [CampaignStatus.partners_recommended],

  // Re-ranking is allowed: the creator may ask for a fresh evaluation before choosing.
  [CampaignStatus.partners_recommended]: [
    CampaignStatus.partners_recommended,
    CampaignStatus.partner_approved,
  ],

  // Approving a partner immediately raises the next human gate: first outreach.
  [CampaignStatus.partner_approved]: [CampaignStatus.outreach_approval_required],

  [CampaignStatus.outreach_approval_required]: [CampaignStatus.outreach_approved],

  [CampaignStatus.outreach_approved]: [CampaignStatus.outreach_sent],

  [CampaignStatus.outreach_sent]: [CampaignStatus.partner_accepted],

  [CampaignStatus.partner_accepted]: [CampaignStatus.circle_add_pending],

  [CampaignStatus.circle_add_pending]: [CampaignStatus.circle_added],

  [CampaignStatus.circle_added]: [CampaignStatus.campaign_active],

  [CampaignStatus.campaign_active]: [CampaignStatus.awaiting_deliverable],

  // The worker moves awaiting → follow_up_due; the collaborator may instead submit
  // early, jumping straight to deliverable_received.
  [CampaignStatus.awaiting_deliverable]: [
    CampaignStatus.follow_up_due,
    CampaignStatus.deliverable_received,
  ],

  [CampaignStatus.follow_up_due]: [CampaignStatus.follow_up_generating],

  // Backing out to `awaiting_deliverable` is what makes §15's "bounded retries" real: if
  // the Mind call or the send fails, the campaign returns to waiting and the worker can try
  // again on a later pass. Without this edge a transient failure would strand the campaign
  // in `follow_up_generating` forever. The one-follow-up cap survives the retry because it
  // is enforced by `followUpCount` plus a unique dedupeKey, not by graph position.
  [CampaignStatus.follow_up_generating]: [
    CampaignStatus.follow_up_sent,
    CampaignStatus.awaiting_deliverable,
  ],

  [CampaignStatus.follow_up_sent]: [CampaignStatus.deliverable_received],

  [CampaignStatus.deliverable_received]: [CampaignStatus.final_approval_required],

  // A rejected deliverable returns to awaiting_deliverable for a revision round. The
  // one-follow-up cap survives this loop because it is enforced by a unique
  // dedupeKey on AgentAction, not by the campaign's position in this graph.
  [CampaignStatus.final_approval_required]: [
    CampaignStatus.completed,
    CampaignStatus.awaiting_deliverable,
  ],

  [CampaignStatus.completed]: [],
  [CampaignStatus.cancelled]: [],
  // Terminal for forward progress; cleanup to `cancelled` is added below.
  [CampaignStatus.failed]: [],
};

/** Complete transition map, including cancellation and failure edges. */
export const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> =
  Object.freeze(
    Object.fromEntries(
      (Object.keys(FORWARD) as CampaignStatus[]).map((state) => {
        const next = new Set<CampaignStatus>(FORWARD[state]);

        // A creator may abandon any campaign that has not already finished.
        if (!TERMINAL_STATES.includes(state)) next.add(CampaignStatus.cancelled);

        // Explicit failure is only reachable where an external call happens.
        if (CAN_FAIL.includes(state)) next.add(CampaignStatus.failed);

        // Allow tidying a failed campaign away without inventing a recovery path.
        if (state === CampaignStatus.failed) next.add(CampaignStatus.cancelled);

        return [state, Object.freeze([...next])];
      }),
    ) as Record<CampaignStatus, readonly CampaignStatus[]>,
  );

export function isTerminal(state: CampaignStatus): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * True when `to` is reachable from `from` in one step.
 *
 * Re-entering the current state is reported as `false` here — it is not a legal
 * *transition* — but the transition service treats it as an idempotent no-op rather
 * than an error. The two concepts are deliberately kept separate.
 */
export function canTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return CAMPAIGN_TRANSITIONS[from].includes(to);
}

/** Thrown when UI or worker code attempts an edge that does not exist. */
export class IllegalTransitionError extends Error {
  readonly code = "ILLEGAL_CAMPAIGN_TRANSITION";
  readonly from: CampaignStatus;
  readonly to: CampaignStatus;

  constructor(from: CampaignStatus, to: CampaignStatus) {
    const allowed = CAMPAIGN_TRANSITIONS[from];
    super(
      `Illegal campaign transition ${from} → ${to}. ` +
        (allowed.length
          ? `Allowed from ${from}: ${allowed.join(", ")}.`
          : `${from} is a terminal state.`),
    );
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** Human-facing labels for the UI. */
export const STATUS_LABELS: Record<CampaignStatus, string> = {
  [CampaignStatus.draft]: "Draft",
  [CampaignStatus.objective_submitted]: "Objective submitted",
  [CampaignStatus.partners_recommended]: "Partners recommended",
  [CampaignStatus.partner_approved]: "Partner approved",
  [CampaignStatus.outreach_approval_required]: "Outreach approval required",
  [CampaignStatus.outreach_approved]: "Outreach approved",
  [CampaignStatus.outreach_sent]: "Outreach sent",
  [CampaignStatus.partner_accepted]: "Partner accepted",
  [CampaignStatus.circle_add_pending]: "Adding to Circle",
  [CampaignStatus.circle_added]: "Added to Circle",
  [CampaignStatus.campaign_active]: "Campaign active",
  [CampaignStatus.awaiting_deliverable]: "Awaiting deliverable",
  [CampaignStatus.follow_up_due]: "Follow-up due",
  [CampaignStatus.follow_up_generating]: "Generating follow-up",
  [CampaignStatus.follow_up_sent]: "Follow-up sent",
  [CampaignStatus.deliverable_received]: "Deliverable received",
  [CampaignStatus.final_approval_required]: "Final approval required",
  [CampaignStatus.completed]: "Completed",
  [CampaignStatus.cancelled]: "Cancelled",
  [CampaignStatus.failed]: "Failed",
};

/** Ordered happy path, used by the UI to render progress. */
export const HAPPY_PATH: readonly CampaignStatus[] = [
  CampaignStatus.objective_submitted,
  CampaignStatus.partners_recommended,
  CampaignStatus.partner_approved,
  CampaignStatus.outreach_approval_required,
  CampaignStatus.outreach_sent,
  CampaignStatus.partner_accepted,
  CampaignStatus.circle_added,
  CampaignStatus.awaiting_deliverable,
  CampaignStatus.follow_up_sent,
  CampaignStatus.deliverable_received,
  CampaignStatus.final_approval_required,
  CampaignStatus.completed,
] as const;
