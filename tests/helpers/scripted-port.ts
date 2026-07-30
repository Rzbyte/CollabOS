/**
 * Scripted `MindsPort` double for deterministic tests.
 *
 * This is dependency injection, NOT a mock covering for a broken integration: production
 * always binds `MindsClientAdapter` against the real client library. Tests need a
 * deterministic Mind so that assertions about ranking, repair, and failure handling are
 * about CollabOS's behaviour rather than the model's.
 *
 * A scripted entry may be a reply string or an `Error`, which lets tests exercise the
 * failure paths (timeout, unauthorised, unreachable) that must never produce a false
 * success state.
 */
import type {
  AskOptions,
  CircleAddResult,
  CircleRemoveResult,
  MindAskResult,
  MindSummary,
  MindsPort,
} from "../../src/lib/minds/client.ts";
import type { CircleMember, MessageRecord } from "@animocabrands/minds-client-lib";

export type ScriptedReply = string | Error;

export class ScriptedMindsPort implements MindsPort {
  /** Every prompt sent, in order — lets tests assert the repair prompt was used. */
  readonly prompts: string[] = [];
  readonly conversationsEnsured: string[] = [];

  private readonly replies: ScriptedReply[];
  private readonly configured: boolean;
  private circle: CircleMember[];
  private cognition: number;
  /** When set, every Circle addition fails — exercises the "no false success" path. */
  private readonly circleAddError: Error | null;

  constructor(options?: {
    replies?: ScriptedReply[];
    configured?: boolean;
    circle?: CircleMember[];
    cognition?: number;
    circleAddError?: Error;
  }) {
    this.replies = [...(options?.replies ?? [])];
    this.configured = options?.configured ?? true;
    this.circle = [...(options?.circle ?? [])];
    this.cognition = options?.cognition ?? 5000;
    this.circleAddError = options?.circleAddError ?? null;
  }

  get askCount(): number {
    return this.prompts.length;
  }

  isConfigured(): boolean {
    return this.configured;
  }

  async ask(options: AskOptions): Promise<MindAskResult> {
    this.prompts.push(options.text);

    const next = this.replies.shift();
    if (next === undefined) {
      throw new Error(
        `ScriptedMindsPort ran out of scripted replies (ask #${this.prompts.length})`,
      );
    }
    if (next instanceof Error) throw next;

    return {
      text: next,
      baselineFingerprint: `baseline-${this.prompts.length}`,
      replyFingerprint: `reply-${this.prompts.length}`,
      latencyMs: 7,
    };
  }

  async checkReachability(): Promise<{ reachable: boolean; detail: string }> {
    return { reachable: true, detail: "scripted port" };
  }

  async validateMind(): Promise<MindSummary> {
    return {
      mindId: "mind_scripted",
      name: "Scripted Partnership Director",
      isEnabled: true,
      model: null,
      email: null,
    };
  }

  async getCognitionBalance(): Promise<number> {
    return this.cognition;
  }

  async ensureConversation(alias: string): Promise<void> {
    this.conversationsEnsured.push(alias);
  }

  async getRecentHistory(): Promise<MessageRecord[]> {
    return [];
  }

  async getCircle(): Promise<CircleMember[]> {
    return [...this.circle];
  }

  async addCircleMember(email: string): Promise<CircleAddResult> {
    if (this.circleAddError) throw this.circleAddError;

    const normalised = email.trim().toLowerCase();
    const already = this.circle.some((m) => m.email?.toLowerCase() === normalised);

    if (!already) this.circle.push({ email: normalised, isSteward: false });

    return {
      outcome: already ? "already_member" : "added",
      members: [...this.circle],
      reference: JSON.stringify({ alreadyInCircle: already ? 1 : 0, humansAdded: already ? 0 : 1 }),
    };
  }

  async removeCircleMember(email: string): Promise<CircleRemoveResult> {
    const normalised = email.trim().toLowerCase();
    const present = this.circle.some((m) => m.email?.toLowerCase() === normalised);
    this.circle = this.circle.filter((m) => m.email?.toLowerCase() !== normalised);

    return {
      outcome: present ? "removed" : "not_a_member",
      members: [...this.circle],
      reference: JSON.stringify({ deactivated: present ? 1 : 0 }),
    };
  }
}

/** Builds a schema-valid ranking reply that puts Mira first and rejects Nova. */
export function buildRankingReply(ids: {
  mira: string;
  alex: string;
  nova: string;
}): string {
  return JSON.stringify({
    summary:
      "Mira Chen is the strongest partner: her audience overlaps directly with beginner " +
      "self-custody learners and she delivered a previous collaboration on time.",
    recommendations: [
      {
        partnerId: ids.mira,
        rank: 1,
        fitScore: 92,
        recommendation: "recommended",
        reasons: [
          "Audience of beginner self-custody learners matches the target audience directly",
          "Completed one previous collaboration on time",
          "Produced the strongest qualified engagement of any past partner",
        ],
        risks: ["Smallest raw audience of the three candidates"],
        memoryUsed: [
          "Completed one previous collaboration on time",
          "Qualified-engagement score 0.82",
          "Prefers concise and practical communication",
        ],
      },
      {
        partnerId: ids.alex,
        rank: 2,
        fitScore: 44,
        recommendation: "consider",
        reasons: ["Largest aligned reach after Mira"],
        risks: [
          "Audience is mostly past the beginner stage, weakening topical alignment",
          "Declined a previous collaboration over a scheduling conflict",
        ],
        memoryUsed: ["Declined previously: scheduling conflict during launch window"],
      },
      {
        partnerId: ids.nova,
        rank: 3,
        fitScore: 3,
        recommendation: "reject",
        reasons: ["No usable alignment with beginner safety education"],
        risks: ["High-risk trading calls conflict with the creator's prohibited topics"],
        memoryUsed: [],
      },
    ],
  });
}

/** Schema-valid outreach message. Omits the accept link deliberately — see the test. */
export function buildOutreachReply(options?: { includeLink?: string }): string {
  const link = options?.includeLink;
  return JSON.stringify({
    subject: "Collaboration on a wallet-safety explainer?",
    body:
      "Hi Mira — your step-by-step self-custody walkthroughs are exactly the register I " +
      "am aiming for on an upcoming wallet-safety video. After how smoothly the last " +
      "collaboration went, I would love to do another." +
      (link ? `\n\nAccept here: ${link}` : ""),
    rationale:
      "Concise and practical, matching her stated preference, and references the " +
      "previous on-time collaboration.",
    memoryUsed: [
      "Completed one previous collaboration on time",
      "Prefers concise and practical communication",
    ],
  });
}

/** Schema-valid campaign brief. */
export function buildBriefReply(): string {
  return JSON.stringify({
    title: "Wallet Safety Basics: A Beginner's First Ten Minutes",
    summary:
      "A joint explainer walking a complete beginner through securing a first wallet, " +
      "combining Maya's evidence-based framing with Mira's step-by-step demonstration style.",
    talkingPoints: [
      "The three mistakes new wallet users make in their first week",
      "Seed phrase storage, demonstrated rather than described",
      "How to verify a transaction before signing it",
    ],
    toneNotes: "Calm and practical. No urgency, no price talk, no hype.",
    successMetric:
      "Comments and questions from viewers who identify as new to self-custody.",
  });
}

/** Schema-valid follow-up message for an overdue deliverable. */
export function buildFollowUpReply(): string {
  return JSON.stringify({
    subject: "Quick check on the wallet-safety segment",
    body:
      "Hi Mira — just a gentle check on the collaboration segment we agreed for the " +
      "wallet-safety launch. No pressure at all; if the timing has slipped or something " +
      "needs changing, tell me and I will move the date.",
    rationale:
      "Concise and practical per her stated preference, and offers an extension rather " +
      "than applying pressure, matching Maya's calm brand voice.",
    memoryUsed: [
      "Prefers concise and practical communication",
      "Delivered the previous collaboration on time, so a soft reminder is appropriate",
    ],
  });
}

/**
 * Ranking reply where the Mind WRONGLY recommends the brand-unsafe partner.
 *
 * Used to prove CollabOS overrides the verdict rather than trusting the model on a hard
 * boundary.
 */
export function buildUnsafeRankingReply(ids: {
  mira: string;
  alex: string;
  nova: string;
}): string {
  return JSON.stringify({
    summary: "Nova Alpha offers by far the largest audience.",
    recommendations: [
      {
        partnerId: ids.nova,
        rank: 1,
        fitScore: 95,
        recommendation: "recommended",
        reasons: ["Largest audience of all candidates at 540,000"],
        risks: [],
        memoryUsed: [],
      },
      {
        partnerId: ids.mira,
        rank: 2,
        fitScore: 70,
        recommendation: "consider",
        reasons: ["Good topical alignment but a much smaller audience"],
        risks: [],
        memoryUsed: ["Completed one previous collaboration on time"],
      },
      {
        partnerId: ids.alex,
        rank: 3,
        fitScore: 40,
        recommendation: "consider",
        reasons: ["Moderate reach"],
        risks: ["Declined previously"],
        memoryUsed: ["Declined previously: scheduling conflict"],
      },
    ],
  });
}
