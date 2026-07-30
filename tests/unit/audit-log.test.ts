/**
 * Audit log projection and credential redaction.
 *
 * The central invariant under test: a failed external action must remain permanently
 * distinguishable from a successful one. If `toTimelineEvents` ever collapsed
 * "attempted" into "succeeded", the Activity Log could present a failure as a success
 * — which CLAUDE.md §14 explicitly forbids.
 */
import { describe, expect, it } from "vitest";

import { toTimelineEvents } from "../../src/lib/audit/log.ts";
import type { AgentAction } from "../../src/generated/prisma/client.ts";
import { sanitiseErrorMessage } from "../../src/lib/minds/errors.ts";

const BASE = new Date("2026-01-01T09:00:00.000Z");
const at = (minutes: number) => new Date(BASE.getTime() + minutes * 60_000);

/** Minimal AgentAction row; only the fields the projection reads are meaningful. */
function action(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    id: "action_1",
    campaignId: "campaign_1",
    correlationId: "corr_1",
    actionType: "circle.add",
    summary: "Add collaborator to Mind Circle",
    reason: null,
    status: "succeeded",
    requiresApproval: false,
    autonomous: false,
    proposedAt: null,
    approvedAt: null,
    attemptedAt: null,
    executedAt: null,
    failedAt: null,
    externalReference: null,
    transport: null,
    errorCode: null,
    sanitisedErrorMessage: null,
    dedupeKey: null,
    createdAt: BASE,
    updatedAt: BASE,
    ...overrides,
  } as AgentAction;
}

describe("toTimelineEvents", () => {
  it("emits one entry per recorded lifecycle timestamp", () => {
    const events = toTimelineEvents([
      action({
        proposedAt: at(0),
        approvedAt: at(1),
        attemptedAt: at(2),
        executedAt: at(3),
      }),
    ]);

    expect(events.map((e) => e.phase)).toEqual([
      "proposed",
      "approved",
      "attempted",
      "succeeded",
    ]);
  });

  it("omits phases that never happened", () => {
    const events = toTimelineEvents([action({ proposedAt: at(0), attemptedAt: at(1) })]);

    expect(events.map((e) => e.phase)).toEqual(["proposed", "attempted"]);
    expect(events.some((e) => e.phase === "succeeded")).toBe(false);
  });

  it("keeps attempted and failed as two separate facts", () => {
    // The load-bearing case: a real external call that was tried and did not work.
    const events = toTimelineEvents([
      action({
        status: "failed",
        proposedAt: at(0),
        attemptedAt: at(1),
        failedAt: at(2),
        errorCode: "MINDS_TRANSPORT_ERROR",
        sanitisedErrorMessage: "Circle mutation rejected",
      }),
    ]);

    expect(events.map((e) => e.phase)).toEqual(["proposed", "attempted", "failed"]);

    // Crucially: no success entry exists for a failed action.
    expect(events.some((e) => e.phase === "succeeded")).toBe(false);

    const failure = events.find((e) => e.phase === "failed");
    expect(failure?.errorCode).toBe("MINDS_TRANSPORT_ERROR");
    expect(failure?.summary).toContain("Failed —");
  });

  it("exposes the error only on the failed entry", () => {
    const events = toTimelineEvents([
      action({
        status: "failed",
        attemptedAt: at(0),
        failedAt: at(1),
        errorCode: "MINDS_REPLY_TIMEOUT",
        sanitisedErrorMessage: "timed out",
      }),
    ]);

    const attempted = events.find((e) => e.phase === "attempted");
    expect(attempted?.errorCode).toBeNull();
    expect(attempted?.sanitisedErrorMessage).toBeNull();
  });

  it("sorts chronologically across multiple actions", () => {
    const events = toTimelineEvents([
      action({ id: "b", summary: "Second", proposedAt: at(10) }),
      action({ id: "a", summary: "First", proposedAt: at(5) }),
    ]);

    expect(events.map((e) => e.actionId)).toEqual(["a", "b"]);
  });

  it("orders phases deterministically when timestamps tie", () => {
    // A fast local operation can record several phases in the same millisecond.
    const same = at(0);
    const events = toTimelineEvents([
      action({ proposedAt: same, attemptedAt: same, executedAt: same }),
    ]);

    expect(events.map((e) => e.phase)).toEqual(["proposed", "attempted", "succeeded"]);
  });

  it("preserves the transport label so test delivery stays identifiable", () => {
    const events = toTimelineEvents([
      action({ actionType: "email.follow_up", transport: "mailpit", executedAt: at(0) }),
    ]);

    expect(events[0]?.transport).toBe("mailpit");
  });

  it("marks autonomous actions so the UI can prove no human triggered them", () => {
    const events = toTimelineEvents([
      action({ autonomous: true, attemptedAt: at(0), executedAt: at(1) }),
    ]);

    expect(events.every((e) => e.autonomous)).toBe(true);
  });

  it("returns an empty timeline for no actions", () => {
    expect(toTimelineEvents([])).toEqual([]);
  });
});

describe("sanitiseErrorMessage", () => {
  it("redacts a JWT-shaped Builder API key", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodW1hbklkIjoiYWJjMTIzIn0.s1gn4tur3V4lu3";
    const output = sanitiseErrorMessage(`Request failed with key ${jwt} attached`);

    expect(output).not.toContain(jwt);
    expect(output).toContain("[redacted-key]");
  });

  it("redacts header-style credential assignments", () => {
    const output = sanitiseErrorMessage("X-Api-Key: abcdef123456 was rejected");
    expect(output).not.toContain("abcdef123456");
    expect(output).toContain("[redacted]");
  });

  it("redacts long opaque tokens", () => {
    const token = "a".repeat(64);
    const output = sanitiseErrorMessage(`token=${token}`);
    expect(output).not.toContain(token);
  });

  it("leaves ordinary diagnostic text intact", () => {
    const message = "Campaign campaign_1 is in state awaiting_deliverable";
    expect(sanitiseErrorMessage(message)).toBe(message);
  });

  it("redacts the live key verbatim if it appears in a message", () => {
    const original = process.env.MINDS_BUILDER_API_KEY;
    process.env.MINDS_BUILDER_API_KEY = "super-secret-key-value-12345";
    try {
      const output = sanitiseErrorMessage(
        "failed using super-secret-key-value-12345 credential",
      );
      expect(output).not.toContain("super-secret-key-value-12345");
      expect(output).toContain("[redacted-key]");
    } finally {
      if (original === undefined) delete process.env.MINDS_BUILDER_API_KEY;
      else process.env.MINDS_BUILDER_API_KEY = original;
    }
  });
});
