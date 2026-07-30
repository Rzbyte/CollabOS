/**
 * Campaign state machine — legal and illegal transitions.
 *
 * Pure tests against the adjacency map, no database. These cover the first two
 * required unit tests in CLAUDE.md §20 and lock down the invariants the transition
 * service depends on.
 */
import { describe, expect, it } from "vitest";

import {
  CAMPAIGN_TRANSITIONS,
  CampaignStatus,
  HAPPY_PATH,
  IllegalTransitionError,
  STATUS_LABELS,
  TERMINAL_STATES,
  canTransition,
  isTerminal,
} from "../../src/lib/campaign/states.ts";

/**
 * Breadth-first search for a forward route between two states.
 *
 * Deliberately refuses to route through `cancelled` or `failed` (unless one is the
 * target), so a "path exists" result can never be satisfied by bailing out through an
 * error edge.
 */
function findRoute(
  from: CampaignStatus,
  to: CampaignStatus,
): CampaignStatus[] | null {
  if (from === to) return [from];

  const detours: CampaignStatus[] = [CampaignStatus.cancelled, CampaignStatus.failed];
  const seen = new Set<CampaignStatus>([from]);
  const queue: CampaignStatus[][] = [[from]];

  while (queue.length) {
    const path = queue.shift() as CampaignStatus[];
    const tail = path[path.length - 1] as CampaignStatus;

    for (const next of CAMPAIGN_TRANSITIONS[tail]) {
      if (next === to) return [...path, next];
      if (seen.has(next)) continue;
      if (detours.includes(next)) continue;

      seen.add(next);
      queue.push([...path, next]);
    }
  }

  return null;
}

describe("legal campaign transitions", () => {
  const legalEdges: Array<[CampaignStatus, CampaignStatus]> = [
    [CampaignStatus.draft, CampaignStatus.objective_submitted],
    [CampaignStatus.objective_submitted, CampaignStatus.partners_recommended],
    [CampaignStatus.partners_recommended, CampaignStatus.partner_approved],
    [CampaignStatus.partner_approved, CampaignStatus.outreach_approval_required],
    [CampaignStatus.outreach_approval_required, CampaignStatus.outreach_approved],
    [CampaignStatus.outreach_approved, CampaignStatus.outreach_sent],
    [CampaignStatus.outreach_sent, CampaignStatus.partner_accepted],
    [CampaignStatus.partner_accepted, CampaignStatus.circle_add_pending],
    [CampaignStatus.circle_add_pending, CampaignStatus.circle_added],
    [CampaignStatus.circle_added, CampaignStatus.campaign_active],
    [CampaignStatus.campaign_active, CampaignStatus.awaiting_deliverable],
    [CampaignStatus.awaiting_deliverable, CampaignStatus.follow_up_due],
    [CampaignStatus.follow_up_due, CampaignStatus.follow_up_generating],
    [CampaignStatus.follow_up_generating, CampaignStatus.follow_up_sent],
    [CampaignStatus.follow_up_sent, CampaignStatus.deliverable_received],
    [CampaignStatus.deliverable_received, CampaignStatus.final_approval_required],
    [CampaignStatus.final_approval_required, CampaignStatus.completed],
  ];

  it.each(legalEdges)("allows %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it("walks the entire happy path end to end", () => {
    // HAPPY_PATH is the UI's progress view, so it lists milestones rather than every
    // state — e.g. awaiting_deliverable → follow_up_sent really runs through
    // follow_up_due and follow_up_generating. Each consecutive pair must therefore be
    // connected by SOME forward route, not necessarily a single edge.
    let current: CampaignStatus = CampaignStatus.draft;

    for (const next of HAPPY_PATH) {
      const route = findRoute(current, next);
      expect(route, `no forward route from ${current} to ${next}`).not.toBeNull();
      current = next;
    }

    expect(current).toBe(CampaignStatus.completed);
    expect(isTerminal(current)).toBe(true);
  });

  it("allows a rejected deliverable to return for revision", () => {
    // Supports the "coordinate deadlines and revisions" requirement.
    expect(
      canTransition(
        CampaignStatus.final_approval_required,
        CampaignStatus.awaiting_deliverable,
      ),
    ).toBe(true);
  });

  it("allows the collaborator to submit early, skipping the follow-up", () => {
    expect(
      canTransition(
        CampaignStatus.awaiting_deliverable,
        CampaignStatus.deliverable_received,
      ),
    ).toBe(true);
  });

  it("allows cancellation from every non-terminal state", () => {
    for (const state of Object.values(CampaignStatus)) {
      if (isTerminal(state)) continue;
      expect(
        canTransition(state, CampaignStatus.cancelled),
        `${state} should be cancellable`,
      ).toBe(true);
    }
  });

  it("allows re-ranking before a partner is chosen", () => {
    expect(
      canTransition(
        CampaignStatus.partners_recommended,
        CampaignStatus.partners_recommended,
      ),
    ).toBe(true);
  });
});

describe("illegal campaign transitions", () => {
  const illegalEdges: Array<[CampaignStatus, CampaignStatus]> = [
    // Cannot skip the partner-approval gate.
    [CampaignStatus.objective_submitted, CampaignStatus.partner_approved],
    // Cannot skip the outreach-approval gate — this is the §18 human control point.
    [CampaignStatus.partner_approved, CampaignStatus.outreach_sent],
    // Cannot reach the Circle without the partner accepting.
    [CampaignStatus.outreach_sent, CampaignStatus.circle_added],
    // Cannot complete without final approval.
    [CampaignStatus.deliverable_received, CampaignStatus.completed],
    // Cannot jump straight from a brand-new campaign to done.
    [CampaignStatus.draft, CampaignStatus.completed],
    // Cannot rewind a completed campaign.
    [CampaignStatus.completed, CampaignStatus.awaiting_deliverable],
    // Cannot send a follow-up without the deadline passing first.
    [CampaignStatus.awaiting_deliverable, CampaignStatus.follow_up_sent],
    // Cannot skip generation.
    [CampaignStatus.follow_up_due, CampaignStatus.follow_up_sent],
    // Circle add must be attempted before it can be recorded as added.
    [CampaignStatus.partner_accepted, CampaignStatus.circle_added],
  ];

  it.each(illegalEdges)("rejects %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it("treats completed and cancelled as fully terminal", () => {
    for (const state of [CampaignStatus.completed, CampaignStatus.cancelled]) {
      expect(CAMPAIGN_TRANSITIONS[state]).toHaveLength(0);
    }
  });

  it("allows only cleanup out of failed, never silent recovery", () => {
    expect(CAMPAIGN_TRANSITIONS[CampaignStatus.failed]).toEqual([
      CampaignStatus.cancelled,
    ]);
  });

  it("produces an actionable error message listing what IS allowed", () => {
    const error = new IllegalTransitionError(
      CampaignStatus.draft,
      CampaignStatus.completed,
    );

    expect(error.code).toBe("ILLEGAL_CAMPAIGN_TRANSITION");
    expect(error.message).toContain("draft → completed");
    expect(error.message).toContain("objective_submitted");
  });

  it("explains that a terminal state has no successors", () => {
    const error = new IllegalTransitionError(
      CampaignStatus.completed,
      CampaignStatus.draft,
    );
    expect(error.message).toContain("terminal state");
  });
});

describe("state machine integrity", () => {
  it("defines transitions for every status in the schema", () => {
    for (const state of Object.values(CampaignStatus)) {
      expect(CAMPAIGN_TRANSITIONS[state], `missing map entry for ${state}`).toBeDefined();
    }
  });

  it("only ever targets states that exist", () => {
    const valid = new Set<string>(Object.values(CampaignStatus));
    for (const [from, targets] of Object.entries(CAMPAIGN_TRANSITIONS)) {
      for (const target of targets) {
        expect(valid.has(target), `${from} → ${target} is not a real state`).toBe(true);
      }
    }
  });

  it("has a human-readable label for every status", () => {
    for (const state of Object.values(CampaignStatus)) {
      expect(STATUS_LABELS[state], `missing label for ${state}`).toBeTruthy();
    }
  });

  it("marks exactly completed, cancelled and failed as terminal", () => {
    expect([...TERMINAL_STATES].sort()).toEqual(
      [CampaignStatus.cancelled, CampaignStatus.completed, CampaignStatus.failed].sort(),
    );
  });

  it("makes every non-terminal state reachable from draft", () => {
    // Guards against orphaned states that could never occur in a real campaign.
    const seen = new Set<CampaignStatus>([CampaignStatus.draft]);
    const queue: CampaignStatus[] = [CampaignStatus.draft];

    while (queue.length) {
      const current = queue.shift() as CampaignStatus;
      for (const next of CAMPAIGN_TRANSITIONS[current]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }

    for (const state of Object.values(CampaignStatus)) {
      expect(seen.has(state), `${state} is unreachable from draft`).toBe(true);
    }
  });
});
