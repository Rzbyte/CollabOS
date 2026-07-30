/**
 * Zod schemas for structured Mind output.
 *
 * CLAUDE.md §11 forbids parsing unstructured prose for state transitions. The Mind is
 * asked for strict JSON and the reply is validated here before a single database row is
 * written.
 *
 * Zod alone is not sufficient, though. A syntactically perfect response can still be
 * *semantically* wrong — a hallucinated partner id, a duplicated rank, a candidate
 * silently dropped. `validateRankingSemantics()` catches those, because a recommendation
 * about a partner that does not exist is worse than no recommendation at all.
 */
import { z } from "zod";

/** Matches the `RecommendationVerdict` enum in the Prisma schema. */
export const RecommendationVerdictSchema = z.enum([
  "recommended",
  "consider",
  "reject",
]);

export type RecommendationVerdictValue = z.infer<typeof RecommendationVerdictSchema>;

export const PartnerRecommendationSchema = z.object({
  partnerId: z.string().min(1, "partnerId is required"),
  rank: z.number().int().positive("rank must be a positive integer"),
  /** 0–100. The prompt states this range explicitly. */
  fitScore: z.number().min(0).max(100),
  recommendation: RecommendationVerdictSchema,
  /** At least one reason — an unexplained verdict is not actionable for the creator. */
  reasons: z.array(z.string().min(1)).min(1, "at least one reason is required"),
  risks: z.array(z.string().min(1)),
  /**
   * The remembered facts the Mind says it used. This is the observable evidence that
   * memory influenced the decision rather than decorating it, so it is required to be
   * non-empty for any candidate that has relationship history.
   */
  memoryUsed: z.array(z.string().min(1)),
});

export type PartnerRecommendationPayload = z.infer<typeof PartnerRecommendationSchema>;

export const PartnerRankingResponseSchema = z.object({
  recommendations: z.array(PartnerRecommendationSchema).min(1),
  /** Optional one-paragraph rationale shown above the candidate cards. */
  summary: z.string().optional(),
});

export type PartnerRankingResponse = z.infer<typeof PartnerRankingResponseSchema>;

/** Follow-up message composed by the Mind. */
export const FollowUpMessageSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(20, "follow-up body is too short to be a real message"),
  /** Why this wording — recorded in the audit log alongside the send. */
  rationale: z.string().min(1),
  /** Remembered facts used to personalise the message. */
  memoryUsed: z.array(z.string().min(1)).default([]),
});

export type FollowUpMessage = z.infer<typeof FollowUpMessageSchema>;

/** Shared campaign brief authored by the Mind. */
export const CampaignBriefSchema = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().min(20),
  talkingPoints: z.array(z.string().min(1)).min(1),
  toneNotes: z.string().optional(),
  successMetric: z.string().optional(),
});

export type CampaignBriefPayload = z.infer<typeof CampaignBriefSchema>;

/**
 * Post-campaign debrief.
 *
 * Explicitly asks for guidance rather than metrics: the Mind has no access to audience
 * analytics, and §18 forbids fabricating campaign metrics. Anything numeric in a debrief
 * would be invented, so the schema has no numeric fields at all.
 */
export const CampaignDebriefSchema = z.object({
  whatWorked: z.array(z.string().min(1)).min(1),
  whatToImprove: z.array(z.string().min(1)),
  /** How this outcome should influence the next partner recommendation. */
  futurePartnerGuidance: z.string().min(1),
  memoryUsed: z.array(z.string().min(1)).default([]),
});

export type CampaignDebriefPayload = z.infer<typeof CampaignDebriefSchema>;

/** Outreach message for the first contact (creator-approved before sending). */
export const OutreachMessageSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(20),
  rationale: z.string().min(1),
  memoryUsed: z.array(z.string().min(1)).default([]),
});

export type OutreachMessage = z.infer<typeof OutreachMessageSchema>;

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

/**
 * Pulls a JSON object out of a Mind reply.
 *
 * Conversational models commonly wrap JSON in ```json fences or add a sentence of
 * preamble. Tolerating that is not the same as prose-parsing: the *payload* is still
 * strict JSON validated against a schema, and if no parseable object is present this
 * returns `null` rather than guessing.
 */
export function extractJsonObject(raw: string): unknown | null {
  const text = raw.trim();

  // 1. Fenced block, with or without a language tag.
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  // 2. The whole reply.
  candidates.push(text);

  // 3. Widest brace span, for replies with surrounding commentary.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === "object") return parsed;
    } catch {
      // Try the next strategy.
    }
  }

  return null;
}

/** Compact, human-readable summary of Zod issues for audit and UI display. */
export function summariseZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

// ---------------------------------------------------------------------------
// Semantic validation
// ---------------------------------------------------------------------------

export interface SemanticIssue {
  code:
    | "unknown_partner"
    | "missing_candidate"
    | "duplicate_partner"
    | "duplicate_rank"
    | "non_contiguous_ranks";
  message: string;
}

/**
 * Checks a schema-valid ranking against the candidates that were actually offered.
 *
 * Guards specifically against the failure modes that would corrupt the demo or mislead
 * the creator:
 *   • a partner id that was never supplied (hallucination)
 *   • a supplied candidate left unranked (silent omission)
 *   • duplicate ids or ranks (incoherent ordering)
 */
export function validateRankingSemantics(
  response: PartnerRankingResponse,
  candidateIds: readonly string[],
): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  const offered = new Set(candidateIds);
  const seenIds = new Set<string>();
  const seenRanks = new Set<number>();

  for (const item of response.recommendations) {
    if (!offered.has(item.partnerId)) {
      issues.push({
        code: "unknown_partner",
        message: `"${item.partnerId}" was not one of the supplied candidates`,
      });
    }

    if (seenIds.has(item.partnerId)) {
      issues.push({
        code: "duplicate_partner",
        message: `"${item.partnerId}" appears more than once`,
      });
    }
    seenIds.add(item.partnerId);

    if (seenRanks.has(item.rank)) {
      issues.push({
        code: "duplicate_rank",
        message: `rank ${item.rank} is used more than once`,
      });
    }
    seenRanks.add(item.rank);
  }

  for (const id of candidateIds) {
    if (!seenIds.has(id)) {
      issues.push({
        code: "missing_candidate",
        message: `candidate "${id}" was not ranked`,
      });
    }
  }

  // Ranks should be exactly 1..n so ordering is unambiguous.
  const ranks = [...seenRanks].sort((a, b) => a - b);
  const expected = ranks.length;
  if (ranks.length && (ranks[0] !== 1 || ranks[expected - 1] !== expected)) {
    issues.push({
      code: "non_contiguous_ranks",
      message: `ranks must be 1..${expected}, received ${ranks.join(", ")}`,
    });
  }

  return issues;
}
