/**
 * Typed error surface for every Minds interaction.
 *
 * Two rules drive this file:
 *
 *  1. Callers must be able to branch on a stable `code` rather than string-matching
 *     a message, because campaign state depends on the distinction (a timeout is
 *     retryable; a 401 is not).
 *  2. Nothing derived from a provider response reaches a log, a database row, or the
 *     UI without passing through `sanitiseErrorMessage()`. A Builder API key is a
 *     JWT and could otherwise be echoed back inside an error body.
 */
import { MindsApiError } from "@animocabrands/minds-client-lib";

export type MindsErrorCode =
  | "MINDS_NOT_CONFIGURED"
  | "MINDS_MIND_NOT_FOUND"
  | "MINDS_UNAUTHORISED"
  | "MINDS_RATE_LIMITED"
  | "MINDS_REPLY_TIMEOUT"
  | "MINDS_EMPTY_REPLY"
  | "MINDS_INVALID_STRUCTURED_OUTPUT"
  | "MINDS_TRANSPORT_ERROR"
  | "MINDS_UNKNOWN";

/** Base class for everything this module throws. */
export class CollabOsMindsError extends Error {
  readonly code: MindsErrorCode;
  readonly retryable: boolean;
  readonly correlationId: string | undefined;
  readonly status: number | undefined;

  constructor(args: {
    code: MindsErrorCode;
    message: string;
    retryable?: boolean;
    correlationId?: string | undefined;
    status?: number | undefined;
    cause?: unknown;
  }) {
    super(sanitiseErrorMessage(args.message), { cause: args.cause });
    this.name = new.target.name;
    this.code = args.code;
    this.retryable = args.retryable ?? false;
    this.correlationId = args.correlationId;
    this.status = args.status;
  }

  /** Shape written to AgentAction. Contains no secrets and no raw provider body. */
  toAuditFields(): { errorCode: string; sanitisedErrorMessage: string } {
    return {
      errorCode: this.code,
      sanitisedErrorMessage: this.message.slice(0, 500),
    };
  }
}

/** Thrown when MINDS_BUILDER_API_KEY / MINDS_MIND_ID are absent. */
export class MindsNotConfiguredError extends CollabOsMindsError {
  constructor(missing: string[], correlationId?: string) {
    super({
      code: "MINDS_NOT_CONFIGURED",
      message:
        `Mind is not connected. Missing configuration: ${missing.join(", ")}. ` +
        `Add the values to .env — see docs/minds-smoke-test.md for the setup checklist.`,
      retryable: false,
      correlationId,
    });
  }
}

/** The Mind did not reply within the allotted window. Retryable. */
export class MindsReplyTimeoutError extends CollabOsMindsError {
  constructor(alias: string, timeoutMs: number, correlationId?: string) {
    super({
      code: "MINDS_REPLY_TIMEOUT",
      message: `Mind did not reply on conversation "${alias}" within ${timeoutMs}ms.`,
      retryable: true,
      correlationId,
    });
  }
}

/** A reply arrived but carried no usable text. */
export class MindsEmptyReplyError extends CollabOsMindsError {
  constructor(alias: string, correlationId?: string) {
    super({
      code: "MINDS_EMPTY_REPLY",
      message: `Mind replied on conversation "${alias}" with no message text.`,
      retryable: true,
      correlationId,
    });
  }
}

/**
 * The Mind replied, but the payload failed Zod validation even after one repair
 * attempt. Explicitly NOT retryable — the caller must surface an actionable error
 * rather than loop, and must never substitute an invented response.
 */
export class MindsStructuredOutputError extends CollabOsMindsError {
  readonly validationSummary: string;

  constructor(validationSummary: string, correlationId?: string) {
    super({
      code: "MINDS_INVALID_STRUCTURED_OUTPUT",
      message:
        `Mind response did not match the required schema after one repair attempt. ` +
        `${validationSummary}`,
      retryable: false,
      correlationId,
    });
    this.validationSummary = validationSummary;
  }
}

/**
 * Redacts anything that could plausibly be a credential.
 *
 * Applied to every message before it is stored or displayed. Ordering matters:
 * the JWT pattern runs before the generic long-token pattern so keys are labelled
 * precisely.
 */
export function sanitiseErrorMessage(input: string): string {
  let out = input;

  // JWTs (Builder API keys are JWTs).
  out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, "[redacted-key]");
  // Bearer / X-Api-Key style header values.
  out = out.replace(/\b(bearer|x-api-key|api[_-]?key|authorization)\b\s*[:=]\s*\S+/gi, "$1: [redacted]");
  // Any remaining long opaque token.
  out = out.replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted-token]");

  // Belt and braces: if the live key is in memory, never let it appear literally.
  const liveKey = process.env.MINDS_BUILDER_API_KEY;
  if (liveKey && liveKey.length > 8) {
    out = out.split(liveKey).join("[redacted-key]");
  }

  return out;
}

/** Maps a client-library / network failure onto the typed surface above. */
export function toCollabOsMindsError(error: unknown, correlationId?: string): CollabOsMindsError {
  if (error instanceof CollabOsMindsError) return error;

  if (error instanceof MindsApiError) {
    const status = error.status;

    if (status === 401 || status === 403) {
      return new CollabOsMindsError({
        code: "MINDS_UNAUTHORISED",
        message: `Minds API rejected the Builder API key (HTTP ${status}). Verify MINDS_BUILDER_API_KEY.`,
        retryable: false,
        correlationId,
        status,
        cause: error,
      });
    }

    if (status === 404) {
      return new CollabOsMindsError({
        code: "MINDS_MIND_NOT_FOUND",
        message: `Minds API returned 404. Verify MINDS_MIND_ID refers to a Mind on this account.`,
        retryable: false,
        correlationId,
        status,
        cause: error,
      });
    }

    if (status === 429) {
      return new CollabOsMindsError({
        code: "MINDS_RATE_LIMITED",
        message: `Minds API rate limited the request (HTTP 429).`,
        retryable: true,
        correlationId,
        status,
        cause: error,
      });
    }

    return new CollabOsMindsError({
      code: "MINDS_TRANSPORT_ERROR",
      message: `Minds API error (HTTP ${status}, code ${error.code}): ${error.message}`,
      // 5xx is worth another attempt; a 4xx we do not recognise is not.
      retryable: status >= 500,
      correlationId,
      status,
      cause: error,
    });
  }

  if (error instanceof Error) {
    // Undici/Node network failures surface as plain Errors.
    const networkish = /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|aborted/i.test(
      error.message,
    );
    return new CollabOsMindsError({
      code: networkish ? "MINDS_TRANSPORT_ERROR" : "MINDS_UNKNOWN",
      message: error.message,
      retryable: networkish,
      correlationId,
      cause: error,
    });
  }

  return new CollabOsMindsError({
    code: "MINDS_UNKNOWN",
    message: `Unknown Minds failure: ${String(error)}`,
    retryable: false,
    correlationId,
  });
}
