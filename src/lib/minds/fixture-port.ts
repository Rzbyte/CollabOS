/**
 * OFFLINE FIXTURE MIND — canned responses, not a real Mind.
 *
 * ## Why this exists
 *
 * CLAUDE.md §20 asks for one Playwright end-to-end test covering the whole flow through the
 * UI. That is impossible without a Mind, and no Builder API key exists in this environment.
 * This port makes the E2E test runnable and lets someone evaluate the interface without
 * credentials.
 *
 * ## Why it is not the "hidden mock" §24 forbids
 *
 * §24 prohibits replacing a failed real integration with a hidden mock. Every word of that
 * matters, so this is the opposite of hidden:
 *
 *   • Opt-in only, via `COLLABOS_UNSAFE_FIXTURE_MIND=1`. The variable is named "unsafe" so
 *     nobody enables it casually or by copy-paste.
 *   • Refuses to load when `NODE_ENV=production` — throws rather than degrading quietly.
 *   • Every page renders a permanent red banner while it is active.
 *   • Every exchange it produces is persisted with `fixtureMode: true`, so a canned reply can
 *     never be mistaken for a genuine one after the fact.
 *   • It logs a warning to the server console on construction.
 *
 * ## What it must never be used for
 *
 * Not for a demo, not for a screenshot presented as real, and not as evidence that the Mind
 * integration works. The real integration is `MindsClientAdapter`; its round trip is
 * genuinely unverified until a key exists, and that is recorded in
 * `docs/known-limitations.md` rather than covered up by this file.
 */
import type { CircleMember, MessageRecord } from "@animocabrands/minds-client-lib";

import type {
  AskOptions,
  CircleAddResult,
  CircleRemoveResult,
  CognitionToolUsage,
  MindAskResult,
  MindSummary,
  MindsPort,
} from "./client.ts";

export const FIXTURE_ENV_FLAG = "COLLABOS_UNSAFE_FIXTURE_MIND";

/**
 * True when the offline fixture Mind is active.
 *
 * Throws in production rather than silently ignoring the flag: a deployment that thinks it
 * enabled a fixture Mind and got a real one (or vice versa) is worse than a hard failure.
 */
export function isFixtureMindEnabled(): boolean {
  const requested = process.env[FIXTURE_ENV_FLAG] === "1";
  if (!requested) return false;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `${FIXTURE_ENV_FLAG} is set but NODE_ENV=production. The offline fixture Mind returns ` +
        `canned responses and must never run in production. Unset the variable.`,
    );
  }

  return true;
}

interface CandidateBlock {
  id: string;
  text: string;
  blocked: boolean;
  hasHistory: boolean;
  declined: boolean;
}

/**
 * Splits the ranking prompt into per-candidate blocks.
 *
 * Position in the prompt carries NO meaning — `loadCandidates` orders partners
 * alphabetically, so ranking by prompt order made the fixture recommend "Alex Morgan" purely
 * because A sorts before M. The fixture must decide from the actual signals in each block,
 * the same way a real Mind would.
 */
function parseCandidateBlocks(prompt: string): CandidateBlock[] {
  const sections = prompt.split(/\nCANDIDATE \d+\n/).slice(1);

  return sections.flatMap((section) => {
    const id = /partnerId:\s*(\S+)/.exec(section)?.[1];
    if (!id) return [];

    return [
      {
        id,
        text: section,
        blocked: section.includes("BRAND-SAFETY CONFLICT"),
        hasHistory: /Completed collaborations:\s*[1-9]/.test(section),
        declined: /Status:\s*declined/.test(section),
      },
    ];
  });
}

/** Canned reply keyed off recognisable phrases in the prompt. */
function replyFor(prompt: string): string {
  // Ranking — the prompt asks for a "recommendations" array.
  if (prompt.includes('"recommendations"')) {
    const blocks = parseCandidateBlocks(prompt);

    // Rank on the signals the scenario actually turns on: brand safety is disqualifying, a
    // completed prior collaboration is the strongest positive, a previous decline is a
    // caution.
    const blocked = blocks.filter((block) => block.blocked);
    const safe = blocks.filter((block) => !block.blocked);
    const ordered = [...safe].sort((a, b) => {
      if (a.hasHistory !== b.hasHistory) return a.hasHistory ? -1 : 1;
      if (a.declined !== b.declined) return a.declined ? 1 : -1;
      return 0;
    });

    const rank1 = ordered[0]?.id ?? "partner_mira";
    const rank2 = ordered[1]?.id ?? "partner_alex";
    const rank3 = blocked[0]?.id ?? ordered[2]?.id ?? "partner_nova";

    return JSON.stringify({
      summary:
        "Ranked on audience relevance and demonstrated reliability rather than reach. The " +
        "smaller, well-matched audience is the stronger partner here.",
      recommendations: [
        {
          partnerId: rank1,
          rank: 1,
          fitScore: 92,
          recommendation: "recommended",
          reasons: [
            "Audience consists of beginners following step-by-step self-custody walkthroughs, matching the target audience directly",
            "Completed a previous collaboration on time",
            "Produced the strongest qualified engagement of any past partner",
          ],
          risks: ["Smallest raw audience of the three candidates"],
          memoryUsed: [
            "Completed one previous collaboration on time",
            "Qualified-engagement score 0.82 from past work",
            "Prefers concise and practical communication",
          ],
        },
        {
          partnerId: rank2,
          rank: 2,
          fitScore: 44,
          recommendation: "consider",
          reasons: ["Largest aligned reach after the top candidate"],
          risks: [
            "Audience is mostly past the beginner stage, weakening topical alignment",
            "Declined a previous collaboration over a scheduling conflict",
          ],
          memoryUsed: ["Declined previously: scheduling conflict during the launch window"],
        },
        {
          partnerId: rank3,
          rank: 3,
          fitScore: 3,
          recommendation: "reject",
          reasons: ["No usable alignment with beginner safety education"],
          risks: [
            "High-risk trading content conflicts with the creator's prohibited topics",
          ],
          memoryUsed: [],
        },
      ],
    });
  }

  // Campaign brief.
  if (prompt.includes('"talkingPoints"')) {
    return JSON.stringify({
      title: "Wallet Safety Basics: A Beginner's First Ten Minutes",
      summary:
        "A joint explainer walking a complete beginner through securing a first wallet, " +
        "combining evidence-based framing with a step-by-step demonstration.",
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

  // Post-campaign debrief.
  if (prompt.includes('"futurePartnerGuidance"')) {
    return JSON.stringify({
      whatWorked: [
        "The beginner-focused framing matched the wallet-safety brief closely",
        "Audience overlap was genuine rather than incidental",
      ],
      whatToImprove: ["Agree the revision window up front next time"],
      futurePartnerGuidance:
        "Keep prioritising audience relevance over reach; this partner remains the strongest " +
        "first choice for beginner safety education.",
      memoryUsed: ["Completed a previous collaboration on time"],
    });
  }

  // Overdue-deliverable follow-up.
  if (/overdue by/i.test(prompt)) {
    return JSON.stringify({
      subject: "Quick check on the wallet-safety segment",
      body:
        "Hi — just a gentle check on the collaboration segment we agreed for the " +
        "wallet-safety launch. No pressure at all; if the timing has slipped or something " +
        "needs changing, tell me and I will move the date.",
      rationale:
        "Concise and practical per the partner's stated preference, offering an extension " +
        "rather than applying pressure, matching the creator's calm brand voice.",
      memoryUsed: [
        "Prefers concise and practical communication",
        "Delivered the previous collaboration on time, so a soft reminder is appropriate",
      ],
    });
  }

  // First outreach.
  if (prompt.includes('"subject"')) {
    return JSON.stringify({
      subject: "Collaboration on a wallet-safety explainer?",
      body:
        "Hi — your step-by-step self-custody walkthroughs are exactly the register I am " +
        "aiming for on an upcoming wallet-safety video, and I would love to work together " +
        "again after how smoothly the last collaboration went.",
      rationale:
        "Opens on the partner's actual work, references the shared history, and keeps to " +
        "their preferred concise style.",
      memoryUsed: [
        "Completed one previous collaboration on time",
        "Prefers concise and practical communication",
      ],
    });
  }

  return JSON.stringify({ note: "FIXTURE MIND — no canned reply matched this prompt." });
}

export class FixtureMindsPort implements MindsPort {
  private circle: CircleMember[] = [
    { email: "steward@example.com", isSteward: true },
  ];

  constructor() {
    console.warn(
      `\n⚠  ${FIXTURE_ENV_FLAG}=1 — OFFLINE FIXTURE MIND ACTIVE.\n` +
        `   Mind responses are canned test data. This is NOT a real Mind and must not be\n` +
        `   presented as a working integration or used for a demo.\n`,
    );
  }

  isConfigured(): boolean {
    return true;
  }

  async checkReachability(): Promise<{ reachable: boolean; detail: string }> {
    return { reachable: true, detail: "FIXTURE MIND — no network call was made" };
  }

  async validateMind(): Promise<MindSummary> {
    return {
      mindId: "fixture-mind",
      name: "FIXTURE MIND (canned responses)",
      isEnabled: true,
      model: "fixture",
      email: null,
    };
  }

  async getCognitionBalance(): Promise<number> {
    // Deliberately not a plausible-looking balance.
    return 0;
  }

  async getCognitionToolUsage(): Promise<CognitionToolUsage> {
    // Deliberately empty rather than plausible: invented tool names would be
    // indistinguishable from real platform usage in a screenshot.
    return { tools: [], totalCredits: 0, totalCalls: 0 };
  }

  async ensureConversation(): Promise<void> {
    /* no-op */
  }

  async ask(options: AskOptions): Promise<MindAskResult> {
    return {
      text: replyFor(options.text),
      baselineFingerprint: undefined,
      replyFingerprint: `fixture-${Date.now()}`,
      latencyMs: 1,
    };
  }

  async getRecentHistory(): Promise<MessageRecord[]> {
    return [];
  }

  async getCircle(): Promise<CircleMember[]> {
    return [...this.circle];
  }

  async addCircleMember(email: string): Promise<CircleAddResult> {
    const normalised = email.trim().toLowerCase();
    const already = this.circle.some((m) => m.email?.toLowerCase() === normalised);
    if (!already) this.circle.push({ email: normalised, isSteward: false });

    return {
      outcome: already ? "already_member" : "added",
      members: [...this.circle],
      reference: `FIXTURE — no real Circle mutation occurred (${
        already ? "already present" : "added locally"
      })`,
    };
  }

  async removeCircleMember(email: string): Promise<CircleRemoveResult> {
    const normalised = email.trim().toLowerCase();
    const present = this.circle.some((m) => m.email?.toLowerCase() === normalised);
    this.circle = this.circle.filter((m) => m.email?.toLowerCase() !== normalised);

    return {
      outcome: present ? "removed" : "not_a_member",
      members: [...this.circle],
      reference: "FIXTURE — no real Circle mutation occurred",
    };
  }
}
