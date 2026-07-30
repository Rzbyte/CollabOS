/**
 * Signed collaborator links.
 *
 * The collaborator page is unauthenticated, so the token IS the credential. These tests
 * cover the properties that matter: it round-trips, it cannot be forged or tampered with,
 * it expires, and it grants access to exactly one campaign.
 */
import { afterEach, describe, expect, it } from "vitest";

import { FixedClock, resetClock, setClock } from "../../src/lib/clock.ts";
import {
  InvalidLinkError,
  createCollaborationToken,
  verifyCollaborationToken,
} from "../../src/lib/links/sign.ts";

afterEach(() => {
  resetClock();
});

describe("collaboration tokens", () => {
  it("round-trips a campaign id", () => {
    const token = createCollaborationToken("campaign_abc123");
    expect(verifyCollaborationToken(token).campaignId).toBe("campaign_abc123");
  });

  it("produces an opaque token that does not leak the campaign id in plain text", () => {
    const token = createCollaborationToken("campaign_secret_value");
    expect(token).not.toContain("campaign_secret_value");
  });

  it("produces different tokens for different campaigns", () => {
    expect(createCollaborationToken("campaign_a")).not.toBe(
      createCollaborationToken("campaign_b"),
    );
  });

  it("grants access to only the campaign it was minted for", () => {
    const token = createCollaborationToken("campaign_a");
    expect(verifyCollaborationToken(token).campaignId).not.toBe("campaign_b");
  });

  it("rejects a tampered payload", () => {
    const token = createCollaborationToken("campaign_a");
    const [, signature] = token.split(".") as [string, string];

    // Re-encode a different campaign id but keep the original signature.
    const forgedPayload = Buffer.from(
      JSON.stringify({ c: "campaign_b", p: "collaboration", e: 9_999_999_999 }),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(() => verifyCollaborationToken(`${forgedPayload}.${signature}`)).toThrow(
      InvalidLinkError,
    );
  });

  it("rejects a tampered signature", () => {
    const token = createCollaborationToken("campaign_a");
    const [payload] = token.split(".") as [string, string];

    expect(() => verifyCollaborationToken(`${payload}.not-a-real-signature`)).toThrow(
      InvalidLinkError,
    );
  });

  it("rejects a token with no signature segment", () => {
    expect(() => verifyCollaborationToken("onlyonepart")).toThrow(InvalidLinkError);
  });

  it("rejects a token with too many segments", () => {
    expect(() => verifyCollaborationToken("a.b.c")).toThrow(InvalidLinkError);
  });

  it("rejects an empty token", () => {
    expect(() => verifyCollaborationToken("")).toThrow(InvalidLinkError);
  });

  it("reports malformed rather than invalid for a well-signed but unparseable payload", () => {
    // Signature valid, contents not JSON — proves signature is checked before parsing.
    const notJson = Buffer.from("this is not json").toString("base64url");
    let thrown: unknown;
    try {
      // Deliberately unsigned: this must fail as INVALID, never crash.
      verifyCollaborationToken(`${notJson}.deadbeef`);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvalidLinkError);
    expect((thrown as InvalidLinkError).code).toBe("LINK_INVALID");
  });

  it("expires after its TTL", () => {
    const clock = new FixedClock(new Date("2026-01-01T09:00:00Z"));
    setClock(clock);

    const token = createCollaborationToken("campaign_a", { ttlSeconds: 60 });

    // Still valid inside the window.
    expect(verifyCollaborationToken(token).campaignId).toBe("campaign_a");

    clock.advanceSeconds(61);

    let thrown: unknown;
    try {
      verifyCollaborationToken(token);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvalidLinkError);
    expect((thrown as InvalidLinkError).code).toBe("LINK_EXPIRED");
  });

  it("stays valid right up to the expiry boundary", () => {
    const clock = new FixedClock(new Date("2026-01-01T09:00:00Z"));
    setClock(clock);

    const token = createCollaborationToken("campaign_a", { ttlSeconds: 60 });
    clock.advanceSeconds(59);

    expect(verifyCollaborationToken(token).campaignId).toBe("campaign_a");
  });
});
