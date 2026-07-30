/**
 * Structured-output repair behaviour (CLAUDE.md §11 / §20).
 *
 * The contract under test:
 *   1. Validate the reply.
 *   2. On failure, record it and retry ONCE with a repair instruction.
 *   3. If the repair also fails, throw — never fabricate a valid response.
 *
 * "Exactly once" is the part worth guarding: an unbounded repair loop would burn
 * cognition and could eventually coax a plausible-looking hallucination out of the model.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { DbClient } from "../../src/lib/audit/log.ts";
import type { MindsPort } from "../../src/lib/minds/client.ts";
import { MindsStructuredOutputError } from "../../src/lib/minds/errors.ts";
import {
  ScriptedMindsPort as BaseScriptedPort,
  type ScriptedReply,
} from "../helpers/scripted-port.ts";
import { askForStructured } from "../../src/lib/minds/reasoning.ts";
import { MindExchangePurpose } from "../../src/generated/prisma/enums.ts";
import {
  PartnerRankingResponseSchema,
  validateRankingSemantics,
} from "../../src/lib/minds/schemas.ts";

const CANDIDATES = ["partner_mira", "partner_alex"] as const;

/** Positional-argument wrapper over the shared double, for readability below. */
class ScriptedMindsPort extends BaseScriptedPort {
  constructor(replies: ScriptedReply[]) {
    super({ replies });
  }
}

interface RecordedExchange {
  purpose: string;
  validated: boolean;
  requestText: string;
  replyText: string | null;
}

/** In-memory stand-in for the `mindExchange` table. */
function createFakeDb(): { db: DbClient; exchanges: RecordedExchange[] } {
  const exchanges: RecordedExchange[] = [];

  const db = {
    mindExchange: {
      create: async (args: {
        data: {
          purpose: string;
          validated: boolean;
          requestText: string;
          replyText: string | null;
        };
      }) => {
        exchanges.push({
          purpose: args.data.purpose,
          validated: args.data.validated,
          requestText: args.data.requestText,
          replyText: args.data.replyText,
        });
        return { id: `exchange_${exchanges.length}` };
      },
    },
    // Only `mindExchange.create` is exercised by askForStructured; the cast keeps the
    // double minimal instead of stubbing the whole Prisma surface.
  } as unknown as DbClient;

  return { db, exchanges };
}

const VALID_REPLY = JSON.stringify({
  summary: "Mira is the strongest fit.",
  recommendations: [
    {
      partnerId: "partner_mira",
      rank: 1,
      fitScore: 90,
      recommendation: "recommended",
      reasons: ["Direct audience overlap"],
      risks: [],
      memoryUsed: ["Delivered on time previously"],
    },
    {
      partnerId: "partner_alex",
      rank: 2,
      fitScore: 40,
      recommendation: "consider",
      reasons: ["Weaker alignment"],
      risks: ["Declined once"],
      memoryUsed: ["Scheduling conflict"],
    },
  ],
});

/** Schema-valid but semantically wrong: names a partner never offered. */
const HALLUCINATED_REPLY = JSON.stringify({
  recommendations: [
    {
      partnerId: "partner_ghost",
      rank: 1,
      fitScore: 99,
      recommendation: "recommended",
      reasons: ["Invented"],
      risks: [],
      memoryUsed: [],
    },
  ],
});

function ask(port: MindsPort, db: DbClient) {
  return askForStructured({
    port,
    alias: "collabos-test",
    campaignId: "campaign_test",
    correlationId: "corr_test",
    purpose: MindExchangePurpose.partner_ranking,
    repairPurpose: MindExchangePurpose.partner_ranking_repair,
    prompt: "ORIGINAL PROMPT",
    schema: PartnerRankingResponseSchema,
    semanticCheck: (value) =>
      validateRankingSemantics(value, CANDIDATES).map((issue) => issue.message),
    buildRepairPrompt: (issues) => `REPAIR: ${issues.join(" | ")}`,
    db,
  });
}

describe("askForStructured — happy path", () => {
  let fake: ReturnType<typeof createFakeDb>;

  beforeEach(() => {
    fake = createFakeDb();
  });

  it("accepts a valid first response without repairing", async () => {
    const port = new ScriptedMindsPort([VALID_REPLY]);
    const result = await ask(port, fake.db);

    expect(result.requiredRepair).toBe(false);
    expect(result.value.recommendations).toHaveLength(2);
    expect(port.askCount).toBe(1);
  });

  it("records the successful exchange as schema-valid", async () => {
    const port = new ScriptedMindsPort([VALID_REPLY]);
    await ask(port, fake.db);

    expect(fake.exchanges).toHaveLength(1);
    expect(fake.exchanges[0]?.validated).toBe(true);
    expect(fake.exchanges[0]?.purpose).toBe("partner_ranking");
  });

  it("tolerates fenced JSON", async () => {
    const port = new ScriptedMindsPort([`\`\`\`json\n${VALID_REPLY}\n\`\`\``]);
    const result = await ask(port, fake.db);

    expect(result.requiredRepair).toBe(false);
    expect(port.askCount).toBe(1);
  });
});

describe("askForStructured — repair path", () => {
  let fake: ReturnType<typeof createFakeDb>;

  beforeEach(() => {
    fake = createFakeDb();
  });

  it("repairs once after a schema failure and succeeds", async () => {
    const port = new ScriptedMindsPort(['{"recommendations":[]}', VALID_REPLY]);
    const result = await ask(port, fake.db);

    expect(result.requiredRepair).toBe(true);
    expect(port.askCount).toBe(2);
    expect(result.value.recommendations).toHaveLength(2);
  });

  it("sends the repair instruction, not the original prompt again", async () => {
    const port = new ScriptedMindsPort(['{"recommendations":[]}', VALID_REPLY]);
    await ask(port, fake.db);

    expect(port.prompts[0]).toBe("ORIGINAL PROMPT");
    expect(port.prompts[1]).toContain("REPAIR:");
  });

  it("repairs after a SEMANTIC failure, not just a schema failure", async () => {
    // Hallucinated partner: passes Zod, fails the semantic check.
    const port = new ScriptedMindsPort([HALLUCINATED_REPLY, VALID_REPLY]);
    const result = await ask(port, fake.db);

    expect(result.requiredRepair).toBe(true);
    expect(port.prompts[1]).toContain("partner_ghost");
  });

  it("repairs after a non-JSON prose reply", async () => {
    const port = new ScriptedMindsPort([
      "I think Mira is the best choice for this campaign.",
      VALID_REPLY,
    ]);
    const result = await ask(port, fake.db);

    expect(result.requiredRepair).toBe(true);
    expect(port.prompts[1]).toContain("parseable JSON");
  });

  it("records the failed attempt as schema-invalid alongside the success", async () => {
    const port = new ScriptedMindsPort(['{"recommendations":[]}', VALID_REPLY]);
    await ask(port, fake.db);

    expect(fake.exchanges).toHaveLength(2);
    expect(fake.exchanges[0]?.validated).toBe(false);
    expect(fake.exchanges[1]?.validated).toBe(true);
    // The repair is recorded under its own purpose so it is distinguishable.
    expect(fake.exchanges[1]?.purpose).toBe("partner_ranking_repair");
  });
});

describe("askForStructured — repair failure", () => {
  let fake: ReturnType<typeof createFakeDb>;

  beforeEach(() => {
    fake = createFakeDb();
  });

  it("throws MindsStructuredOutputError when the repair also fails", async () => {
    const port = new ScriptedMindsPort(['{"bad":1}', '{"also":"bad"}']);

    await expect(ask(port, fake.db)).rejects.toThrow(MindsStructuredOutputError);
  });

  it("retries exactly once — never more", async () => {
    // Only two replies are scripted. A third ask would throw "ran out of scripted
    // replies" instead of the structured-output error, so this assertion is meaningful.
    const port = new ScriptedMindsPort(['{"bad":1}', '{"also":"bad"}']);

    await expect(ask(port, fake.db)).rejects.toThrow(MindsStructuredOutputError);
    expect(port.askCount).toBe(2);
  });

  it("reports both failures in the error, so the problem is diagnosable", async () => {
    const port = new ScriptedMindsPort(["not json at all", '{"recommendations":[]}']);

    await expect(ask(port, fake.db)).rejects.toThrow(/First attempt.*Repair attempt/s);
  });

  it("marks the error as non-retryable — callers must not loop", async () => {
    const port = new ScriptedMindsPort(['{"bad":1}', '{"also":"bad"}']);

    try {
      await ask(port, fake.db);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(MindsStructuredOutputError);
      expect((error as MindsStructuredOutputError).retryable).toBe(false);
    }
  });

  it("records both failed exchanges and fabricates nothing", async () => {
    const port = new ScriptedMindsPort(['{"bad":1}', '{"also":"bad"}']);

    await expect(ask(port, fake.db)).rejects.toThrow();

    expect(fake.exchanges).toHaveLength(2);
    expect(fake.exchanges.every((exchange) => !exchange.validated)).toBe(true);
  });
});
