/**
 * Server-only wrapper around `@animocabrands/minds-client-lib`.
 *
 * Every capability here maps to a method that genuinely exists in the installed
 * package (verified against `dist/index.d.ts` of 0.1.3) — no invented endpoints and
 * no hand-rolled HTTP adapter, because the official client covers the full surface
 * CollabOS needs.
 *
 * What this wrapper adds on top of the raw client:
 *   • correlation IDs threaded through every call for audit joins
 *   • bounded retry with backoff, gated on the typed `retryable` flag
 *   • request timeouts via AbortSignal
 *   • the correct reply-detection sequence (fingerprint baseline BEFORE send)
 *   • verify-then-mutate Circle semantics with post-mutation confirmation
 *   • credential-safe errors
 *
 * Consumers depend on the `MindsPort` interface rather than this implementation, so
 * tests can inject a deterministic double without the production path changing.
 */
import {
  createMindsClient,
  type CircleMember,
  type MessageRecord,
  type MindsClient,
} from "@animocabrands/minds-client-lib";

import { loadEnv } from "../../env.ts";
import {
  CollabOsMindsError,
  MindsEmptyReplyError,
  MindsNotConfiguredError,
  MindsReplyTimeoutError,
  sanitiseErrorMessage,
  toCollabOsMindsError,
} from "./errors.ts";
import { FixtureMindsPort, isFixtureMindEnabled } from "./fixture-port.ts";

// A Builder API key must never be loaded in a browser context.
if (typeof window !== "undefined") {
  throw new Error(
    "src/lib/minds/client.ts is server-only and was imported from a browser bundle.",
  );
}

/** Wall-clock + network budget for a single Mind question. */
const DEFAULT_MAX_ATTEMPTS = 3;
const READ_TIMEOUT_MS = 20_000;

export interface MindSummary {
  mindId: string;
  name: string | null;
  isEnabled: boolean;
  model: string | null;
  email: string | null;
}

export interface MindAskResult {
  text: string;
  baselineFingerprint: string | undefined;
  replyFingerprint: string | undefined;
  latencyMs: number;
}

export interface CircleAddResult {
  /** `already_member` is a success — Circle addition must be idempotent (§16). */
  outcome: "added" | "already_member";
  members: CircleMember[];
  /** Sanitised platform response summary, stored for audit. */
  reference: string;
}

export interface CircleRemoveResult {
  outcome: "removed" | "not_a_member";
  members: CircleMember[];
  reference: string;
}

export interface AskOptions {
  alias: string;
  text: string;
  correlationId: string;
  timeoutMs?: number;
}

/** One tool the Mind actually invoked, with what it cost. */
export interface CognitionToolUse {
  tool: string;
  callCount: number;
  creditsUsed: number;
  firstUsed: string | null;
  lastUsed: string | null;
}

/**
 * Per-tool cognition spend for the configured Mind.
 *
 * IMPORTANT: this is **Mind-wide**, not campaign-scoped. The platform bills cognition
 * against the Mind, and the Builder API exposes no campaign dimension, so these totals
 * include smoke tests and every earlier campaign. Any UI that renders this must say so —
 * presenting it as one campaign's cost would be exactly the fabricated metric §18 bans.
 */
export interface CognitionToolUsage {
  /** Highest spend first. */
  tools: CognitionToolUse[];
  totalCredits: number;
  totalCalls: number;
}

/**
 * The seam between CollabOS and the Minds platform.
 *
 * Production binds this to `MindsClientAdapter`. Tests bind a scripted double, which
 * is dependency injection for determinism — not a mock hiding a broken integration.
 */
export interface MindsPort {
  isConfigured(): boolean;
  /** Unauthenticated reachability probe via the public Bazaar catalogue. */
  checkReachability(): Promise<{ reachable: boolean; detail: string }>;
  validateMind(): Promise<MindSummary>;
  getCognitionBalance(): Promise<number>;
  getCognitionToolUsage(): Promise<CognitionToolUsage>;
  ensureConversation(alias: string): Promise<void>;
  ask(options: AskOptions): Promise<MindAskResult>;
  getRecentHistory(alias: string, limit?: number): Promise<MessageRecord[]>;
  getCircle(): Promise<CircleMember[]>;
  addCircleMember(email: string): Promise<CircleAddResult>;
  removeCircleMember(email: string): Promise<CircleRemoveResult>;
}

export class MindsClientAdapter implements MindsPort {
  private readonly client: MindsClient;
  private readonly mindId: string;
  private readonly apiKey: string;
  private readonly replyTimeoutMs: number;
  private readonly maxAttempts: number;

  constructor(options?: { maxAttempts?: number }) {
    const env = loadEnv();
    this.apiKey = env.MINDS_BUILDER_API_KEY;
    this.mindId = env.MINDS_MIND_ID;
    this.replyTimeoutMs = env.MINDS_REPLY_TIMEOUT_MS;
    this.maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    // The Bazaar catalogue is public, so a client without a key is still useful for
    // reachability checks. Authenticated calls guard on `requireConfigured()`.
    this.client = createMindsClient(
      this.apiKey ? { builderApiKey: this.apiKey } : {},
    );
  }

  isConfigured(): boolean {
    return this.apiKey !== "" && this.mindId !== "";
  }

  private requireConfigured(correlationId?: string): void {
    if (this.isConfigured()) return;
    const missing: string[] = [];
    if (!this.apiKey) missing.push("MINDS_BUILDER_API_KEY");
    if (!this.mindId) missing.push("MINDS_MIND_ID");
    throw new MindsNotConfiguredError(missing, correlationId);
  }

  /**
   * Retries only when the typed error says it is safe to. A 401 or a schema
   * violation is never retried — repeating it would just burn cognition.
   */
  private async withRetry<T>(
    operation: string,
    correlationId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    let lastError: CollabOsMindsError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await fn();
      } catch (raw) {
        const error = toCollabOsMindsError(raw, correlationId);
        lastError = error;

        if (!error.retryable || attempt === this.maxAttempts) break;

        // 400ms, 800ms, 1600ms — short enough for a live demo.
        const backoffMs = 400 * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    throw (
      lastError ??
      new CollabOsMindsError({
        code: "MINDS_UNKNOWN",
        message: `${operation} failed without producing an error`,
        correlationId,
      })
    );
  }

  async checkReachability(): Promise<{ reachable: boolean; detail: string }> {
    try {
      // Public endpoint — proves the host is up independently of credentials.
      const result = await this.client.bazaar.listSkills({
        pageSize: 1,
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      return {
        reachable: true,
        detail: `public Bazaar catalogue reachable (totalCount=${result.totalCount})`,
      };
    } catch (raw) {
      const error = toCollabOsMindsError(raw);
      return { reachable: false, detail: error.message };
    }
  }

  /** Confirms MINDS_MIND_ID actually belongs to this builder account. */
  async validateMind(): Promise<MindSummary> {
    const correlationId = newCorrelationId();
    this.requireConfigured(correlationId);

    return this.withRetry("validateMind", correlationId, async () => {
      const minds = await this.client.listMinds({
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });

      const match = minds.find((mind) => mind.mindId === this.mindId);
      if (!match) {
        throw new CollabOsMindsError({
          code: "MINDS_MIND_NOT_FOUND",
          message:
            `Configured MINDS_MIND_ID is not present on this builder account ` +
            `(${minds.length} Mind(s) visible). Run \`minds list --pretty\` and copy an exact mindId.`,
          retryable: false,
          correlationId,
        });
      }

      return {
        mindId: match.mindId,
        name: match.name ?? null,
        isEnabled: match.isEnabled ?? true,
        model: match.model ?? null,
        email: match.email ?? null,
      };
    });
  }

  async getCognitionBalance(): Promise<number> {
    const correlationId = newCorrelationId();
    this.requireConfigured(correlationId);

    return this.withRetry("getCognitionBalance", correlationId, async () => {
      const balance = await this.client.getCognitionBalance(
        this.mindId,
        AbortSignal.timeout(READ_TIMEOUT_MS),
      );
      return balance.cognition;
    });
  }

  /**
   * Reads per-tool cognition spend.
   *
   * Evidence that the Mind does tool work rather than only producing text — the balance
   * alone is a number, whereas this shows which capabilities were exercised.
   *
   * Rows are normalised defensively. The Circle summary taught us that this platform can
   * return shapes the published types do not promise (a genuine add reported all-zero
   * counters), so nothing here assumes a field is present or numeric.
   */
  async getCognitionToolUsage(): Promise<CognitionToolUsage> {
    const correlationId = newCorrelationId();
    this.requireConfigured(correlationId);

    return this.withRetry("getCognitionUsageByTool", correlationId, async () => {
      const response = await this.client.getCognitionUsageByTool(this.mindId, {
        // This endpoint accepts hour | day | week | month only — NOT the finer intervals
        // `getCognitionUsage` takes. `day` keeps a demo that crosses midnight readable.
        interval: "day",
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });

      const rows: unknown = response.summary;
      const tools: CognitionToolUse[] = (Array.isArray(rows) ? rows : [])
        .map((row: Record<string, unknown>) => ({
          tool: typeof row.tool === "string" && row.tool !== "" ? row.tool : "(unnamed)",
          callCount: Number(row.callCount ?? 0),
          creditsUsed: Number(row.creditsUsed ?? 0),
          firstUsed: typeof row.firstUsed === "string" ? row.firstUsed : null,
          lastUsed: typeof row.lastUsed === "string" ? row.lastUsed : null,
        }))
        .filter((row) => Number.isFinite(row.callCount) && Number.isFinite(row.creditsUsed))
        .sort((a, b) => b.creditsUsed - a.creditsUsed);

      return {
        tools,
        totalCredits: tools.reduce((sum, row) => sum + row.creditsUsed, 0),
        totalCalls: tools.reduce((sum, row) => sum + row.callCount, 0),
      };
    });
  }

  /**
   * Binds a durable alias to the Mind. Idempotent in the client library (handles
   * 409), which is what lets CollabOS reuse one alias per creator forever — the
   * mechanism behind cross-session continuity.
   */
  async ensureConversation(alias: string): Promise<void> {
    const correlationId = newCorrelationId();
    this.requireConfigured(correlationId);

    await this.withRetry("ensureConversation", correlationId, async () => {
      await this.client.ensureConversation(alias, this.mindId);
    });
  }

  /**
   * Asks the Mind a question and waits for its reply.
   *
   * The fingerprint baseline is captured BEFORE sending. Without it, a reply left
   * over from a previous turn can be misread as the answer to this one.
   */
  async ask(options: AskOptions): Promise<MindAskResult> {
    const { alias, text, correlationId } = options;
    const timeoutMs = options.timeoutMs ?? this.replyTimeoutMs;
    this.requireConfigured(correlationId);

    const startedAt = Date.now();

    const baselineFingerprint = await this.withRetry(
      "getLatestHistoryFingerprint",
      correlationId,
      () =>
        this.client.getLatestHistoryFingerprint(
          alias,
          AbortSignal.timeout(READ_TIMEOUT_MS),
        ),
    );

    // Not retried: a duplicate send would post the question to the Mind twice.
    try {
      await this.client.sendMessage({ alias, messageText: text });
    } catch (raw) {
      throw toCollabOsMindsError(raw, correlationId);
    }

    let outcome;
    try {
      outcome = await this.client.waitForReply({
        alias,
        timeoutMs,
        sentMessageText: text,
        ...(baselineFingerprint ? { afterFingerprint: baselineFingerprint } : {}),
      });
    } catch (raw) {
      throw toCollabOsMindsError(raw, correlationId);
    }

    if (outcome.timedOut) {
      throw new MindsReplyTimeoutError(alias, timeoutMs, correlationId);
    }

    const replyText = outcome.reply.messageText?.trim();
    if (!replyText) {
      throw new MindsEmptyReplyError(alias, correlationId);
    }

    return {
      text: replyText,
      baselineFingerprint,
      replyFingerprint: outcome.reply.fingerprint,
      latencyMs: Date.now() - startedAt,
    };
  }

  async getRecentHistory(alias: string, limit = 20): Promise<MessageRecord[]> {
    const correlationId = newCorrelationId();
    this.requireConfigured(correlationId);

    return this.withRetry("getHistory", correlationId, () =>
      this.client.getHistory(alias, {
        limit,
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      }),
    );
  }

  async getCircle(): Promise<CircleMember[]> {
    const correlationId = newCorrelationId();
    this.requireConfigured(correlationId);

    return this.withRetry("getCircle", correlationId, () =>
      this.client.getCircle(this.mindId, AbortSignal.timeout(READ_TIMEOUT_MS)),
    );
  }

  /**
   * Adds one human collaborator, then CONFIRMS the result by re-reading the Circle.
   *
   * Reading before mutating satisfies "verify current membership before mutation";
   * reading after is what makes "never fabricate Circle success" enforceable — we
   * only report success when the platform itself lists the member.
   */
  async addCircleMember(email: string): Promise<CircleAddResult> {
    const correlationId = newCorrelationId();
    this.requireConfigured(correlationId);

    const normalised = email.trim().toLowerCase();
    assertHumanCollaboratorEmail(normalised);

    const before = await this.getCircle();
    if (containsEmail(before, normalised)) {
      return {
        outcome: "already_member",
        members: before,
        reference: "verified-before-mutation: already in Circle",
      };
    }

    const mutation = await this.withRetry("addCircleMembers", correlationId, () =>
      this.client.addCircleMembers(this.mindId, {
        emails: [normalised],
        isActive: true,
      }),
    );

    // Reading the Circle back is the ONLY trustworthy success signal.
    //
    // Verified against the live platform 2026-07-30: a mutation that genuinely created a new
    // party and added it returned an all-zero summary —
    // `{activated:0, humansAdded:0, humansCreatedAndAdded:0, alreadyInCircle:0, totalProcessed:0}`.
    // Treating any summary counter as the success signal would therefore report FAILURE on a
    // successful add, stranding the campaign at `circle_add_failed`. The summary is stored for
    // audit only.
    const after = await this.getCircle();
    const summary = sanitiseErrorMessage(JSON.stringify(mutation.summary ?? {}));

    if (!containsEmail(after, normalised)) {
      throw new CollabOsMindsError({
        code: "MINDS_TRANSPORT_ERROR",
        message:
          `Circle mutation completed but the collaborator is not listed in the Circle ` +
          `afterwards. Platform summary: ${summary}`,
        retryable: false,
        correlationId,
      });
    }

    // The pre-mutation read above already returned early for an existing member, so reaching
    // here means the address was absent before and is present now. `alreadyInCircle` is
    // consulted only in case the platform starts populating it later; it is not depended on.
    const alreadyThere = Number(mutation.summary?.alreadyInCircle ?? 0) > 0;

    return {
      outcome: alreadyThere ? "already_member" : "added",
      members: after,
      reference: summary,
    };
  }

  async removeCircleMember(email: string): Promise<CircleRemoveResult> {
    const correlationId = newCorrelationId();
    this.requireConfigured(correlationId);

    const normalised = email.trim().toLowerCase();

    const before = await this.getCircle();
    if (!containsEmail(before, normalised)) {
      return {
        outcome: "not_a_member",
        members: before,
        reference: "verified-before-mutation: not in Circle",
      };
    }

    const mutation = await this.withRetry("removeCircleMembers", correlationId, () =>
      this.client.removeCircleMembers(this.mindId, { emails: [normalised] }),
    );

    const after = await this.getCircle();
    return {
      outcome: containsEmail(after, normalised) ? "not_a_member" : "removed",
      members: after,
      reference: sanitiseErrorMessage(JSON.stringify(mutation.summary ?? {})),
    };
  }
}

/**
 * Blocks Mind platform addresses. Official guidance: "Circles accept human
 * collaborator emails only, not Mind @hellominds.ai addresses."
 */
export function assertHumanCollaboratorEmail(email: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new CollabOsMindsError({
      code: "MINDS_TRANSPORT_ERROR",
      message: `"${email}" is not a valid collaborator email address.`,
      retryable: false,
    });
  }

  if (/@hellominds\.ai$/i.test(email)) {
    throw new CollabOsMindsError({
      code: "MINDS_TRANSPORT_ERROR",
      message:
        `Refusing to add "${email}" to a Circle: Circles are for human collaborator ` +
        `emails only, and Mind-to-Mind Circle membership is not a supported builder workflow.`,
      retryable: false,
    });
  }
}

function containsEmail(members: CircleMember[], email: string): boolean {
  return members.some((member) => member.email?.trim().toLowerCase() === email);
}

export function newCorrelationId(): string {
  return crypto.randomUUID();
}

let singleton: MindsPort | null = null;

/**
 * Process-wide port.
 *
 * Returns the OFFLINE FIXTURE Mind when `COLLABOS_UNSAFE_FIXTURE_MIND=1`, which exists only
 * so the Playwright end-to-end test can run without credentials. That path throws outright
 * under `NODE_ENV=production`, surfaces a permanent banner in the UI, and marks every stored
 * exchange with `fixtureMode: true` — see `fixture-port.ts` for why this is a labelled test
 * seam rather than the hidden mock §24 forbids.
 */
export function getMindsPort(): MindsPort {
  if (singleton) return singleton;

  singleton = isFixtureMindEnabled()
    ? new FixtureMindsPort()
    : new MindsClientAdapter();

  return singleton;
}

