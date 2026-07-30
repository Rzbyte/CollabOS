/**
 * Outbound message transport.
 *
 * Deliberately an interface with a `isTestTransport` flag rather than a direct nodemailer
 * call, for two reasons:
 *
 *   1. §17 requires that a real provider can be added later WITHOUT changing campaign
 *      logic. Campaign code depends on `EmailTransport`, never on Mailpit.
 *   2. §14 forbids presenting a mocked action as a real external action. Because the flag
 *      travels with every `SendResult`, the audit row and the UI label are derived from
 *      the transport itself and cannot drift out of sync with reality.
 *
 * There is no real-provider implementation in this milestone, by design. Nothing here can
 * deliver to the public internet.
 */
import { createTransport, type Transporter } from "nodemailer";

import { loadEnv } from "../../env.ts";

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain text. CollabOS does not send HTML email. */
  body: string;
  /** Display name for the From header; the address itself is transport-controlled. */
  fromName?: string;
}

export interface SendResult {
  /** Transport identifier, stored on the audit row and rendered in the UI. */
  transport: string;
  /** Provider-side id (Mailpit returns a Message-ID). */
  externalReference: string;
  /** True when delivery is captured locally and never leaves the machine. */
  isTestTransport: boolean;
  acceptedRecipients: number;
}

export interface EmailTransport {
  readonly name: string;
  readonly isTestTransport: boolean;
  /** Human-readable label for the UI, e.g. "Local test transport · mailpit". */
  readonly label: string;
  send(message: EmailMessage): Promise<SendResult>;
}

export class EmailTransportError extends Error {
  readonly code = "EMAIL_TRANSPORT_ERROR";
  readonly transport: string;

  constructor(transport: string, message: string, cause?: unknown) {
    super(`${transport} transport failed: ${message}`, { cause });
    this.name = "EmailTransportError";
    this.transport = transport;
  }
}

/**
 * Mailpit — a LOCAL SMTP sink.
 *
 * Captures every message and exposes it at http://localhost:8025. It does not relay, so
 * even a real address in `to` cannot receive anything.
 */
export class MailpitTransport implements EmailTransport {
  readonly name = "mailpit";
  readonly isTestTransport = true;
  readonly label = "Local test transport · Mailpit";

  private transporter: Transporter | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {}

  private getTransporter(): Transporter {
    this.transporter ??= createTransport({
      host: this.host,
      port: this.port,
      // Mailpit accepts anonymous, unencrypted local SMTP; there is nothing to secure
      // because the traffic never leaves the loopback interface.
      secure: false,
      ignoreTLS: true,
      tls: { rejectUnauthorized: false },
    });
    return this.transporter;
  }

  async send(message: EmailMessage): Promise<SendResult> {
    try {
      const info = await this.getTransporter().sendMail({
        from: `"${message.fromName ?? "CollabOS"} (via CollabOS test transport)" <collabos@localhost>`,
        to: message.to,
        subject: message.subject,
        text: message.body,
        headers: {
          // Makes the nature of the message unmistakable in the captured headers.
          "X-CollabOS-Transport": "mailpit-local-test",
          "X-CollabOS-Notice": "Captured locally by Mailpit. Not delivered externally.",
        },
      });

      return {
        transport: this.name,
        externalReference: String(info.messageId ?? "(no message id)"),
        isTestTransport: true,
        acceptedRecipients: Array.isArray(info.accepted) ? info.accepted.length : 0,
      };
    } catch (error) {
      throw new EmailTransportError(
        this.name,
        error instanceof Error ? error.message : String(error),
        error,
      );
    }
  }
}

/** Fallback that logs instead of sending. Used when EMAIL_TRANSPORT=console. */
export class ConsoleTransport implements EmailTransport {
  readonly name = "console";
  readonly isTestTransport = true;
  readonly label = "Local test transport · console log";

  async send(message: EmailMessage): Promise<SendResult> {
    console.log(
      [
        "",
        "─".repeat(72),
        "LOCAL TEST TRANSPORT (console) — nothing was sent to any real recipient",
        `To:      ${message.to}`,
        `Subject: ${message.subject}`,
        "─".repeat(72),
        message.body,
        "─".repeat(72),
        "",
      ].join("\n"),
    );

    return {
      transport: this.name,
      externalReference: `console:${Date.now()}`,
      isTestTransport: true,
      acceptedRecipients: 1,
    };
  }
}

let singleton: EmailTransport | null = null;

export function getEmailTransport(): EmailTransport {
  if (singleton) return singleton;

  const env = loadEnv();
  singleton =
    env.EMAIL_TRANSPORT === "console"
      ? new ConsoleTransport()
      : new MailpitTransport(env.MAILPIT_HOST, env.MAILPIT_SMTP_PORT);

  return singleton;
}

/** Test seam. */
export function setEmailTransport(transport: EmailTransport | null): void {
  singleton = transport;
}

/** Deep link to the captured message in the Mailpit web UI. */
export function mailpitInboxUrl(): string {
  return loadEnv().mailpitWebUrl;
}
