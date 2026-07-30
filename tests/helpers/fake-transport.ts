/**
 * Recording email transport for tests.
 *
 * Implements the same `EmailTransport` interface as Mailpit, so campaign logic is exercised
 * unchanged — which also demonstrates the §17 requirement that a different provider can be
 * swapped in without touching campaign code.
 */
import type {
  EmailMessage,
  EmailTransport,
  SendResult,
} from "../../src/lib/email/transport.ts";
import { EmailTransportError } from "../../src/lib/email/transport.ts";

export class RecordingTransport implements EmailTransport {
  readonly name = "test-recorder";
  readonly isTestTransport = true;
  readonly label = "Local test transport · recorder";

  readonly sent: EmailMessage[] = [];
  private failNext = false;

  /** Makes the next send throw, to exercise the failure path. */
  failOnce(): void {
    this.failNext = true;
  }

  async send(message: EmailMessage): Promise<SendResult> {
    if (this.failNext) {
      this.failNext = false;
      throw new EmailTransportError(this.name, "simulated SMTP failure");
    }

    this.sent.push(message);

    return {
      transport: this.name,
      externalReference: `test-message-${this.sent.length}`,
      isTestTransport: true,
      acceptedRecipients: 1,
    };
  }
}
