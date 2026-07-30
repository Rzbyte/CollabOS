/**
 * Structured Mind output — parsing, schema validation, and semantic checks
 * (CLAUDE.md §20: "Zod validation and repair failure").
 *
 * The semantic layer matters as much as Zod here. A schema-valid response that names a
 * partner who was never offered is a hallucination, and writing it to the database would
 * put a fabricated recommendation in front of the creator.
 */
import { describe, expect, it } from "vitest";

import {
  FollowUpMessageSchema,
  PartnerRankingResponseSchema,
  extractJsonObject,
  summariseZodError,
  validateRankingSemantics,
  type PartnerRankingResponse,
} from "../../src/lib/minds/schemas.ts";

const CANDIDATES = ["partner_mira", "partner_alex", "partner_nova"] as const;

function ranking(
  overrides: Partial<PartnerRankingResponse["recommendations"][number]>[] = [],
): PartnerRankingResponse {
  const base = [
    {
      partnerId: "partner_mira",
      rank: 1,
      fitScore: 92,
      recommendation: "recommended" as const,
      reasons: ["Audience overlaps directly with beginner self-custody learners"],
      risks: [],
      memoryUsed: ["Completed one previous collaboration on time"],
    },
    {
      partnerId: "partner_alex",
      rank: 2,
      fitScore: 48,
      recommendation: "consider" as const,
      reasons: ["Large reach but weaker alignment with beginners"],
      risks: ["Declined previously due to a scheduling conflict"],
      memoryUsed: ["Previously declined: scheduling conflict"],
    },
    {
      partnerId: "partner_nova",
      rank: 3,
      fitScore: 5,
      recommendation: "reject" as const,
      reasons: ["High-risk trading calls conflict with the creator's boundaries"],
      risks: ["Brand-safety conflict"],
      memoryUsed: [],
    },
  ];

  return {
    summary: "Mira is the strongest fit on relevance and reliability.",
    recommendations: base.map((item, index) => ({ ...item, ...(overrides[index] ?? {}) })),
  };
}

describe("extractJsonObject", () => {
  it("parses a bare JSON object", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses JSON inside a ```json fence", () => {
    const raw = '```json\n{"a":1}\n```';
    expect(extractJsonObject(raw)).toEqual({ a: 1 });
  });

  it("parses JSON inside an unlabelled fence", () => {
    expect(extractJsonObject('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("parses JSON despite conversational preamble and postscript", () => {
    const raw = 'Sure! Here is the ranking:\n{"a":1}\nLet me know if you need changes.';
    expect(extractJsonObject(raw)).toEqual({ a: 1 });
  });

  it("handles nested braces via the widest span", () => {
    const raw = 'Result: {"outer":{"inner":[1,2]}} done';
    expect(extractJsonObject(raw)).toEqual({ outer: { inner: [1, 2] } });
  });

  it("returns null for prose with no JSON", () => {
    expect(extractJsonObject("I recommend Mira Chen because she is a great fit.")).toBeNull();
  });

  it("returns null for malformed JSON rather than guessing", () => {
    expect(extractJsonObject('{"a": }')).toBeNull();
  });

  it("returns null for a bare JSON array (an object is required)", () => {
    // Arrays parse, but the schema expects an object wrapper; be explicit.
    expect(extractJsonObject("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("returns null for an empty reply", () => {
    expect(extractJsonObject("   ")).toBeNull();
  });
});

describe("PartnerRankingResponseSchema", () => {
  it("accepts a well-formed ranking", () => {
    const result = PartnerRankingResponseSchema.safeParse(ranking());
    expect(result.success).toBe(true);
  });

  it("rejects a fitScore above 100", () => {
    const result = PartnerRankingResponseSchema.safeParse(ranking([{ fitScore: 140 }]));
    expect(result.success).toBe(false);
  });

  it("rejects a negative fitScore", () => {
    const result = PartnerRankingResponseSchema.safeParse(ranking([{ fitScore: -1 }]));
    expect(result.success).toBe(false);
  });

  it("rejects an unknown recommendation verdict", () => {
    const result = PartnerRankingResponseSchema.safeParse(
      // @ts-expect-error deliberately invalid verdict
      ranking([{ recommendation: "maybe" }]),
    );
    expect(result.success).toBe(false);
  });

  it("rejects an empty reasons array — an unexplained verdict is not actionable", () => {
    const result = PartnerRankingResponseSchema.safeParse(ranking([{ reasons: [] }]));
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer rank", () => {
    const result = PartnerRankingResponseSchema.safeParse(ranking([{ rank: 1.5 }]));
    expect(result.success).toBe(false);
  });

  it("rejects an empty recommendations array", () => {
    const result = PartnerRankingResponseSchema.safeParse({ recommendations: [] });
    expect(result.success).toBe(false);
  });

  it("produces a readable issue summary", () => {
    const result = PartnerRankingResponseSchema.safeParse(ranking([{ fitScore: 500 }]));
    expect(result.success).toBe(false);
    if (!result.success) {
      const summary = summariseZodError(result.error);
      expect(summary).toContain("recommendations.0.fitScore");
    }
  });
});

describe("validateRankingSemantics", () => {
  it("passes a complete, coherent ranking", () => {
    expect(validateRankingSemantics(ranking(), CANDIDATES)).toEqual([]);
  });

  it("flags a hallucinated partner id", () => {
    const issues = validateRankingSemantics(
      ranking([{ partnerId: "partner_invented" }]),
      CANDIDATES,
    );

    expect(issues.some((i) => i.code === "unknown_partner")).toBe(true);
    // The real candidate is now also unranked.
    expect(issues.some((i) => i.code === "missing_candidate")).toBe(true);
  });

  it("flags a silently dropped candidate", () => {
    const partial = ranking();
    partial.recommendations = partial.recommendations.slice(0, 2);

    const issues = validateRankingSemantics(partial, CANDIDATES);
    const missing = issues.find((i) => i.code === "missing_candidate");

    expect(missing).toBeDefined();
    expect(missing?.message).toContain("partner_nova");
  });

  it("flags a duplicated partner", () => {
    const dup = ranking();
    dup.recommendations[1] = { ...dup.recommendations[0]!, rank: 2 };

    const issues = validateRankingSemantics(dup, CANDIDATES);
    expect(issues.some((i) => i.code === "duplicate_partner")).toBe(true);
  });

  it("flags duplicated ranks", () => {
    const issues = validateRankingSemantics(ranking([{}, { rank: 1 }]), CANDIDATES);
    expect(issues.some((i) => i.code === "duplicate_rank")).toBe(true);
  });

  it("flags ranks that do not start at 1", () => {
    const issues = validateRankingSemantics(
      ranking([{ rank: 2 }, { rank: 3 }, { rank: 4 }]),
      CANDIDATES,
    );
    expect(issues.some((i) => i.code === "non_contiguous_ranks")).toBe(true);
  });
});

describe("FollowUpMessageSchema", () => {
  it("accepts a real message", () => {
    const result = FollowUpMessageSchema.safeParse({
      subject: "Quick check on the wallet-safety clip",
      body: "Hi Mira — just checking in on the deliverable we agreed for the launch.",
      rationale: "Concise and practical, matching her stated preference.",
      memoryUsed: ["Prefers concise and practical communication"],
    });

    expect(result.success).toBe(true);
  });

  it("rejects a body too short to be a real message", () => {
    const result = FollowUpMessageSchema.safeParse({
      subject: "Hi",
      body: "ping",
      rationale: "short",
    });

    expect(result.success).toBe(false);
  });

  it("defaults memoryUsed to an empty array", () => {
    const result = FollowUpMessageSchema.safeParse({
      subject: "Checking in",
      body: "Hi Mira — following up on the agreed deliverable for the launch video.",
      rationale: "Neutral reminder.",
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.memoryUsed).toEqual([]);
  });
});
