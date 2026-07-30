/**
 * Deterministic brand-safety enforcement.
 *
 * This is CollabOS territory, not the Mind's. The Mind is *asked* to respect Maya's
 * prohibited topics and is expected to reject Nova Alpha on its own — but a hard brand
 * boundary must not depend on a model reaching the right conclusion.
 *
 * So safety is enforced twice: the Mind reasons about it, and this module overrides the
 * result if the Mind gets it wrong. An override is itself recorded, because silently
 * "correcting" the Mind would hide a real signal about the Mind's behaviour.
 *
 * Pure functions only — no I/O — so the safety rules are cheap to test exhaustively.
 */
import type { Partner } from "../../generated/prisma/client.ts";

/**
 * Reduces a topic or flag to a comparable token.
 *
 * `"leverage trading"`, `"leverage_trading"`, and `"Leverage-Trading"` must all collide,
 * because the creator writes prohibited topics in prose while partner flags are stored
 * as identifiers.
 */
export function normaliseTopic(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface BrandSafetyConflict {
  /** The creator's prohibited topic that was violated. */
  prohibitedTopic: string;
  /** The partner safety flag that violated it. */
  partnerFlag: string;
}

/**
 * Finds collisions between a creator's prohibited topics and a partner's safety flags.
 *
 * Matching is bidirectional-substring on normalised tokens so that
 * `"high_risk_trading_calls"` is caught by the prohibited topic `"leverage trading"`
 * only when genuinely related — exact token containment, not fuzzy similarity.
 */
export function findBrandSafetyConflicts(
  prohibitedTopics: readonly string[],
  partnerSafetyFlags: readonly string[],
): BrandSafetyConflict[] {
  const conflicts: BrandSafetyConflict[] = [];

  for (const topic of prohibitedTopics) {
    const normalisedTopic = normaliseTopic(topic);
    if (!normalisedTopic) continue;

    for (const flag of partnerSafetyFlags) {
      const normalisedFlag = normaliseTopic(flag);
      if (!normalisedFlag) continue;

      if (
        normalisedFlag === normalisedTopic ||
        normalisedFlag.includes(normalisedTopic) ||
        normalisedTopic.includes(normalisedFlag)
      ) {
        conflicts.push({ prohibitedTopic: topic, partnerFlag: flag });
      }
    }
  }

  return conflicts;
}

export interface SafetyAssessment {
  /** True when this partnership is forbidden outright. */
  blocked: boolean;
  conflicts: BrandSafetyConflict[];
  /** Creator-facing explanation, safe to render directly. */
  explanation: string | null;
}

export function assessPartnerSafety(
  prohibitedTopics: readonly string[],
  partner: Pick<Partner, "name" | "safetyFlags">,
): SafetyAssessment {
  const conflicts = findBrandSafetyConflicts(prohibitedTopics, partner.safetyFlags);

  if (conflicts.length === 0) {
    return { blocked: false, conflicts: [], explanation: null };
  }

  const pairs = conflicts
    .map((c) => `"${c.partnerFlag}" conflicts with prohibited topic "${c.prohibitedTopic}"`)
    .join("; ");

  return {
    blocked: true,
    conflicts,
    explanation:
      `${partner.name} is blocked by a hard brand-safety boundary: ${pairs}. ` +
      `CollabOS refuses this partnership regardless of audience size or fit score.`,
  };
}

/** Raised when something attempts to approve or contact a blocked partner. */
export class BrandSafetyViolationError extends Error {
  readonly code = "BRAND_SAFETY_VIOLATION";
  readonly conflicts: BrandSafetyConflict[];

  constructor(partnerName: string, conflicts: BrandSafetyConflict[]) {
    super(
      `Refusing to proceed with "${partnerName}": ` +
        conflicts
          .map((c) => `${c.partnerFlag} violates prohibited topic "${c.prohibitedTopic}"`)
          .join("; ") +
        `. This boundary cannot be overridden from the UI.`,
    );
    this.name = "BrandSafetyViolationError";
    this.conflicts = conflicts;
  }
}

/** Raised when something attempts to contact a partner who declined or opted out. */
export class PartnerContactBlockedError extends Error {
  readonly code = "PARTNER_CONTACT_BLOCKED";
  readonly reason: "opted_out" | "rejected";

  constructor(partnerName: string, reason: "opted_out" | "rejected") {
    super(
      reason === "opted_out"
        ? `Refusing to contact "${partnerName}": the partner has opted out of outreach.`
        : `Refusing to contact "${partnerName}": the creator rejected this partner for ` +
          `this campaign.`,
    );
    this.name = "PartnerContactBlockedError";
    this.reason = reason;
  }
}
