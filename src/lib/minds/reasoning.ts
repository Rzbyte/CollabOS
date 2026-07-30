/**
 * Structured reasoning against the Mind.
 *
 * Implements the CLAUDE.md §11 contract exactly:
 *   1. Ask for JSON matching a schema.
 *   2. Validate (Zod, then semantic checks).
 *   3. On failure, record the failure and retry ONCE with a repair instruction.
 *   4. If the repair also fails, throw. Never fabricate a valid response.
 *
 * Every exchange is persisted as a `MindExchange` row — prompt, reply, and whether it
 * validated — so a judge can read exactly what the Mind was asked and what it said. That
 * record is also what `PartnerRecommendation.rawMindResponseReference` points at.
 */
import type { ZodType } from "zod";
import { z } from "zod";

import { MindExchangePurpose } from "../../generated/prisma/enums.ts";
import { prisma } from "../db.ts";
import type { DbClient } from "../audit/log.ts";
import type { MindsPort } from "./client.ts";
import { MindsStructuredOutputError } from "./errors.ts";
import { isFixtureMindEnabled } from "./fixture-port.ts";
import {
  CampaignBriefSchema,
  CampaignDebriefSchema,
  FollowUpMessageSchema,
  OutreachMessageSchema,
  PartnerRankingResponseSchema,
  type CampaignBriefPayload,
  type CampaignDebriefPayload,
  type FollowUpMessage,
  type OutreachMessage,
  type PartnerRankingResponse,
  extractJsonObject,
  summariseZodError,
  validateRankingSemantics,
} from "./schemas.ts";

export { MindExchangePurpose };

export interface StructuredAskResult<T> {
  value: T;
  /** MindExchange id of the exchange that produced the accepted value. */
  exchangeId: string;
  /** True when the first attempt failed and the repair retry succeeded. */
  requiredRepair: boolean;
}

interface StructuredAskInput<T> {
  port: MindsPort;
  alias: string;
  campaignId?: string | null;
  correlationId: string;
  purpose: MindExchangePurpose;
  repairPurpose?: MindExchangePurpose;
  prompt: string;
  schema: ZodType<T>;
  /** Extra checks that Zod cannot express (e.g. "this partner was never offered"). */
  semanticCheck?: (value: T) => string[];
  buildRepairPrompt: (issues: string[]) => string;
  db?: DbClient;
}

/**
 * Sends a prompt, validates the reply, and repairs at most once.
 *
 * The repair is sent as a follow-up message on the SAME conversation alias, so the Mind
 * still has the original request in its own context and only needs the corrections.
 */
export async function askForStructured<T>(
  input: StructuredAskInput<T>,
): Promise<StructuredAskResult<T>> {
  const db = input.db ?? prisma;

  const first = await attempt(input, input.prompt, input.purpose, db);
  if (first.ok) {
    return { value: first.value, exchangeId: first.exchangeId, requiredRepair: false };
  }

  // One repair attempt, with the exact validation failures restated.
  const repairPrompt = input.buildRepairPrompt(first.issues);
  const second = await attempt(
    input,
    repairPrompt,
    input.repairPurpose ?? input.purpose,
    db,
  );

  if (second.ok) {
    return { value: second.value, exchangeId: second.exchangeId, requiredRepair: true };
  }

  // Both attempts failed. Surface an actionable error rather than inventing a result.
  throw new MindsStructuredOutputError(
    `First attempt: ${first.issues.join("; ")}. ` +
      `Repair attempt: ${second.issues.join("; ")}.`,
    input.correlationId,
  );
}

type AttemptOutcome<T> =
  | { ok: true; value: T; exchangeId: string }
  | { ok: false; issues: string[]; exchangeId: string };

async function attempt<T>(
  input: StructuredAskInput<T>,
  prompt: string,
  purpose: MindExchangePurpose,
  db: DbClient,
): Promise<AttemptOutcome<T>> {
  const reply = await input.port.ask({
    alias: input.alias,
    text: prompt,
    correlationId: input.correlationId,
  });

  const issues: string[] = [];
  let value: T | undefined;

  const parsedJson = extractJsonObject(reply.text);
  if (parsedJson === null) {
    issues.push("response did not contain a parseable JSON object");
  } else {
    const result = input.schema.safeParse(parsedJson);
    if (!result.success) {
      issues.push(summariseZodError(result.error as z.ZodError));
    } else {
      const semanticIssues = input.semanticCheck?.(result.data) ?? [];
      if (semanticIssues.length) issues.push(...semanticIssues);
      else value = result.data;
    }
  }

  const validated = issues.length === 0;

  const exchange = await db.mindExchange.create({
    data: {
      campaignId: input.campaignId ?? null,
      correlationId: input.correlationId,
      purpose,
      alias: input.alias,
      baselineFingerprint: reply.baselineFingerprint ?? null,
      replyFingerprint: reply.replyFingerprint ?? null,
      requestText: prompt,
      replyText: reply.text,
      validated,
      latencyMs: reply.latencyMs,
      // Persisted so a canned fixture reply can never later be mistaken for a real one.
      fixtureMode: isFixtureMindEnabled(),
    },
    select: { id: true },
  });

  if (validated && value !== undefined) {
    return { ok: true, value, exchangeId: exchange.id };
  }

  return { ok: false, issues, exchangeId: exchange.id };
}

// ---------------------------------------------------------------------------
// Task-specific wrappers
// ---------------------------------------------------------------------------

export async function requestPartnerRanking(input: {
  port: MindsPort;
  alias: string;
  campaignId: string;
  correlationId: string;
  prompt: string;
  candidateIds: readonly string[];
  db?: DbClient;
}): Promise<StructuredAskResult<PartnerRankingResponse>> {
  const { candidateIds } = input;

  return askForStructured({
    port: input.port,
    alias: input.alias,
    campaignId: input.campaignId,
    correlationId: input.correlationId,
    purpose: MindExchangePurpose.partner_ranking,
    repairPurpose: MindExchangePurpose.partner_ranking_repair,
    prompt: input.prompt,
    schema: PartnerRankingResponseSchema,
    semanticCheck: (value) =>
      validateRankingSemantics(value, candidateIds).map((issue) => issue.message),
    buildRepairPrompt: (issues) =>
      // Imported lazily-by-value to keep prompt text in one module.
      buildRankingRepair(issues, candidateIds),
    ...(input.db ? { db: input.db } : {}),
  });
}

function buildRankingRepair(issues: string[], candidateIds: readonly string[]): string {
  return [
    `Your previous response could not be used. It failed validation:`,
    ...issues.map((issue) => `  - ${issue}`),
    ``,
    `Send the corrected response now. Requirements:`,
    `- JSON only. No markdown fences, no commentary.`,
    `- Exactly ${candidateIds.length} entries in "recommendations".`,
    `- "partnerId" must be one of these exact strings: ${candidateIds.join(", ")}`,
    `- Ranks must be 1..${candidateIds.length}, each used exactly once.`,
    `- "fitScore" must be an integer between 0 and 100.`,
    `- "reasons" must contain at least one entry per candidate.`,
    `- Do not invent data.`,
  ].join("\n");
}

export async function requestFollowUpMessage(input: {
  port: MindsPort;
  alias: string;
  campaignId: string;
  correlationId: string;
  prompt: string;
  db?: DbClient;
}): Promise<StructuredAskResult<FollowUpMessage>> {
  return askForStructured({
    port: input.port,
    alias: input.alias,
    campaignId: input.campaignId,
    correlationId: input.correlationId,
    purpose: MindExchangePurpose.follow_up_message,
    prompt: input.prompt,
    schema: FollowUpMessageSchema,
    buildRepairPrompt: (issues) =>
      [
        `Your previous response could not be used. It failed validation:`,
        ...issues.map((issue) => `  - ${issue}`),
        ``,
        `Send only this JSON object, with no fences or commentary:`,
        `{ "subject": "...", "body": "...", "rationale": "...", "memoryUsed": ["..."] }`,
        `The body must be at least 20 characters of real message text.`,
      ].join("\n"),
    ...(input.db ? { db: input.db } : {}),
  });
}

export async function requestCampaignBrief(input: {
  port: MindsPort;
  alias: string;
  campaignId: string;
  correlationId: string;
  prompt: string;
  db?: DbClient;
}): Promise<StructuredAskResult<CampaignBriefPayload>> {
  return askForStructured({
    port: input.port,
    alias: input.alias,
    campaignId: input.campaignId,
    correlationId: input.correlationId,
    purpose: MindExchangePurpose.campaign_brief,
    prompt: input.prompt,
    schema: CampaignBriefSchema,
    buildRepairPrompt: (issues) =>
      [
        `Your previous response could not be used. It failed validation:`,
        ...issues.map((issue) => `  - ${issue}`),
        ``,
        `Send only this JSON object, with no fences or commentary:`,
        `{ "title": "...", "summary": "...", "talkingPoints": ["..."], "toneNotes": "...", "successMetric": "..." }`,
      ].join("\n"),
    ...(input.db ? { db: input.db } : {}),
  });
}

export async function requestCampaignDebrief(input: {
  port: MindsPort;
  alias: string;
  campaignId: string;
  correlationId: string;
  prompt: string;
  db?: DbClient;
}): Promise<StructuredAskResult<CampaignDebriefPayload>> {
  return askForStructured({
    port: input.port,
    alias: input.alias,
    campaignId: input.campaignId,
    correlationId: input.correlationId,
    purpose: MindExchangePurpose.campaign_debrief,
    prompt: input.prompt,
    schema: CampaignDebriefSchema,
    buildRepairPrompt: (issues) =>
      [
        `Your previous response could not be used. It failed validation:`,
        ...issues.map((issue) => `  - ${issue}`),
        ``,
        `Send only this JSON object, with no fences or commentary:`,
        `{ "whatWorked": ["..."], "whatToImprove": ["..."], "futurePartnerGuidance": "...", "memoryUsed": ["..."] }`,
        `Do not include any audience metrics — none exist.`,
      ].join("\n"),
    ...(input.db ? { db: input.db } : {}),
  });
}

export async function requestOutreachMessage(input: {
  port: MindsPort;
  alias: string;
  campaignId: string;
  correlationId: string;
  prompt: string;
  db?: DbClient;
}): Promise<StructuredAskResult<OutreachMessage>> {
  return askForStructured({
    port: input.port,
    alias: input.alias,
    campaignId: input.campaignId,
    correlationId: input.correlationId,
    purpose: MindExchangePurpose.partner_ranking,
    prompt: input.prompt,
    schema: OutreachMessageSchema,
    buildRepairPrompt: (issues) =>
      [
        `Your previous response could not be used. It failed validation:`,
        ...issues.map((issue) => `  - ${issue}`),
        ``,
        `Send only this JSON object, with no fences or commentary:`,
        `{ "subject": "...", "body": "...", "rationale": "...", "memoryUsed": ["..."] }`,
      ].join("\n"),
    ...(input.db ? { db: input.db } : {}),
  });
}

