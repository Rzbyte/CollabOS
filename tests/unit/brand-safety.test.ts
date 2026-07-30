/**
 * Brand-safety enforcement (CLAUDE.md §20: "brand-safety candidate is rejected or
 * flagged").
 *
 * These tests encode the demo's central safety claim: Nova Alpha must be blocked because
 * of Maya's prohibited topics, regardless of having the largest audience of the three.
 */
import { describe, expect, it } from "vitest";

import {
  BrandSafetyViolationError,
  PartnerContactBlockedError,
  assessPartnerSafety,
  findBrandSafetyConflicts,
  normaliseTopic,
} from "../../src/lib/safety/brand-safety.ts";

const MAYA_PROHIBITED = ["gambling", "leverage trading", "token shilling"];

describe("normaliseTopic", () => {
  it("collapses separators and case so prose and identifiers collide", () => {
    // The creator writes prose; partner flags are identifiers. They must match.
    expect(normaliseTopic("leverage trading")).toBe("leveragetrading");
    expect(normaliseTopic("leverage_trading")).toBe("leveragetrading");
    expect(normaliseTopic("Leverage-Trading")).toBe("leveragetrading");
    expect(normaliseTopic("  LEVERAGE   TRADING  ")).toBe("leveragetrading");
  });

  it("returns an empty string for punctuation-only input", () => {
    expect(normaliseTopic("---")).toBe("");
  });
});

describe("findBrandSafetyConflicts", () => {
  it("matches an underscored partner flag against a prose prohibited topic", () => {
    const conflicts = findBrandSafetyConflicts(MAYA_PROHIBITED, ["leverage_trading"]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toEqual({
      prohibitedTopic: "leverage trading",
      partnerFlag: "leverage_trading",
    });
  });

  it("finds every conflict, not just the first", () => {
    const conflicts = findBrandSafetyConflicts(MAYA_PROHIBITED, [
      "leverage_trading",
      "token_shilling",
    ]);
    expect(conflicts).toHaveLength(2);
  });

  it("matches when the flag contains the prohibited topic as a substring", () => {
    const conflicts = findBrandSafetyConflicts(
      ["leverage trading"],
      ["high_risk_leverage_trading_calls"],
    );
    expect(conflicts).toHaveLength(1);
  });

  it("returns nothing for an unrelated flag", () => {
    expect(
      findBrandSafetyConflicts(MAYA_PROHIBITED, ["beginner_education"]),
    ).toHaveLength(0);
  });

  it("returns nothing when the partner has no flags", () => {
    expect(findBrandSafetyConflicts(MAYA_PROHIBITED, [])).toHaveLength(0);
  });

  it("returns nothing when the creator sets no boundaries", () => {
    expect(findBrandSafetyConflicts([], ["leverage_trading"])).toHaveLength(0);
  });

  it("ignores empty strings rather than matching everything", () => {
    // A naive substring check would treat "" as matching every flag.
    expect(findBrandSafetyConflicts([""], ["leverage_trading"])).toHaveLength(0);
    expect(findBrandSafetyConflicts(MAYA_PROHIBITED, [""])).toHaveLength(0);
  });
});

describe("assessPartnerSafety — the seeded scenario", () => {
  it("blocks Nova Alpha despite the largest audience", () => {
    const assessment = assessPartnerSafety(MAYA_PROHIBITED, {
      name: "Nova Alpha",
      safetyFlags: ["leverage_trading", "high_risk_trading_calls", "token_shilling"],
    });

    expect(assessment.blocked).toBe(true);
    expect(assessment.conflicts.length).toBeGreaterThanOrEqual(2);
    expect(assessment.explanation).toContain("Nova Alpha");
    // The explanation must make the override explicit for the creator.
    expect(assessment.explanation).toContain("regardless of audience size");
  });

  it("clears Mira Chen", () => {
    const assessment = assessPartnerSafety(MAYA_PROHIBITED, {
      name: "Mira Chen",
      safetyFlags: [],
    });

    expect(assessment.blocked).toBe(false);
    expect(assessment.conflicts).toHaveLength(0);
    expect(assessment.explanation).toBeNull();
  });

  it("clears Alex Morgan — a weak fit is not a safety block", () => {
    // Alex should be treated cautiously for fit reasons, but caution is the Mind's
    // judgement, not a hard boundary CollabOS enforces.
    const assessment = assessPartnerSafety(MAYA_PROHIBITED, {
      name: "Alex Morgan",
      safetyFlags: [],
    });

    expect(assessment.blocked).toBe(false);
  });
});

describe("guard errors", () => {
  it("BrandSafetyViolationError names the conflict and refuses UI override", () => {
    const error = new BrandSafetyViolationError("Nova Alpha", [
      { prohibitedTopic: "leverage trading", partnerFlag: "leverage_trading" },
    ]);

    expect(error.code).toBe("BRAND_SAFETY_VIOLATION");
    expect(error.message).toContain("Nova Alpha");
    expect(error.message).toContain("leverage trading");
    expect(error.message).toContain("cannot be overridden");
  });

  it("PartnerContactBlockedError distinguishes opt-out from creator rejection", () => {
    const optedOut = new PartnerContactBlockedError("Alex Morgan", "opted_out");
    expect(optedOut.reason).toBe("opted_out");
    expect(optedOut.message).toContain("opted out");

    const rejected = new PartnerContactBlockedError("Alex Morgan", "rejected");
    expect(rejected.reason).toBe("rejected");
    expect(rejected.message).toContain("rejected this partner");
  });
});
