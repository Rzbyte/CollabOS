/**
 * Signed collaborator links.
 *
 * The collaborator page is reachable without authentication — a partner should not need a
 * CollabOS account to accept a collaboration or submit a deliverable. The link itself is
 * therefore the credential, so it must be unguessable, tamper-evident, and expiring.
 *
 * HMAC-SHA256 over a compact payload, compared with `timingSafeEqual`. The token grants
 * access to exactly one campaign and nothing else: it carries no email address and no
 * permission to mutate a Circle, which is why §16's "do not accept arbitrary Circle emails
 * from browser input" holds even though this endpoint is public.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { loadEnv } from "../../env.ts";
import { getClock } from "../clock.ts";

/** Collaborator links stay valid long enough to survive a demo or a weekend. */
const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;

export type LinkPurpose = "collaboration";

interface TokenPayload {
  /** campaignId */
  c: string;
  /** purpose */
  p: LinkPurpose;
  /** expiry, epoch seconds */
  e: number;
}

export class InvalidLinkError extends Error {
  readonly code: "LINK_INVALID" | "LINK_EXPIRED" | "LINK_MALFORMED";

  constructor(code: "LINK_INVALID" | "LINK_EXPIRED" | "LINK_MALFORMED", message: string) {
    super(message);
    this.name = "InvalidLinkError";
    this.code = code;
  }
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

function sign(payload: string, secret: string): string {
  return base64UrlEncode(createHmac("sha256", secret).update(payload).digest());
}

/** Creates an opaque token granting access to one campaign's collaborator page. */
export function createCollaborationToken(
  campaignId: string,
  options?: { ttlSeconds?: number },
): string {
  const secret = loadEnv().signingSecret;
  const nowSeconds = Math.floor(getClock().now().getTime() / 1000);

  const payload: TokenPayload = {
    c: campaignId,
    p: "collaboration",
    e: nowSeconds + (options?.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  };

  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

/**
 * Verifies a token and returns the campaign it grants access to.
 *
 * Signature is checked BEFORE expiry so a tampered payload can never influence which error
 * is reported, and the comparison is constant-time.
 */
export function verifyCollaborationToken(token: string): { campaignId: string } {
  const secret = loadEnv().signingSecret;

  const parts = token.split(".");
  if (parts.length !== 2) {
    throw new InvalidLinkError("LINK_MALFORMED", "This collaboration link is malformed.");
  }

  const [encoded, providedSignature] = parts as [string, string];

  const expected = sign(encoded, secret);
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(providedSignature);

  if (
    expectedBuffer.length !== providedBuffer.length ||
    !timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    throw new InvalidLinkError("LINK_INVALID", "This collaboration link is not valid.");
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(base64UrlDecode(encoded).toString("utf8")) as TokenPayload;
  } catch {
    throw new InvalidLinkError("LINK_MALFORMED", "This collaboration link is malformed.");
  }

  if (payload.p !== "collaboration" || typeof payload.c !== "string" || !payload.c) {
    throw new InvalidLinkError("LINK_MALFORMED", "This collaboration link is malformed.");
  }

  const nowSeconds = Math.floor(getClock().now().getTime() / 1000);
  if (typeof payload.e !== "number" || payload.e < nowSeconds) {
    throw new InvalidLinkError(
      "LINK_EXPIRED",
      "This collaboration link has expired. Ask the creator to send a new one.",
    );
  }

  return { campaignId: payload.c };
}

/** Absolute URL for the collaborator page. */
export function collaborationUrl(campaignId: string): string {
  const env = loadEnv();
  const base = env.APP_URL.replace(/\/+$/, "");
  return `${base}/collab/${createCollaborationToken(campaignId)}`;
}
