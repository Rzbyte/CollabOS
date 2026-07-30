/**
 * Prompt construction.
 *
 * Every prompt is built from records read out of Postgres, so the Mind reasons over
 * CollabOS's operational truth rather than whatever it happens to recall from earlier
 * turns. That split is the whole architecture: the Mind supplies judgement, CollabOS
 * supplies facts.
 *
 * Two constraints are repeated in every prompt because they are the ones that matter
 * most for trust:
 *   1. Do not invent metrics, replies, or history beyond what is supplied.
 *   2. Return only JSON matching the stated shape.
 */
import type {
  CreatorProfile,
  Partner,
  Relationship,
} from "../../generated/prisma/client.ts";

export interface CandidateContext {
  partner: Partner;
  relationship: Relationship | null;
  /** Deterministic brand-safety verdict, computed by CollabOS before asking. */
  safetyConflicts: string[];
}

/** Header used on every message so the Mind can recognise its operating contract. */
const ROLE_HEADER = `You are the Creator Partnership Director for a creator-collaboration operations system called CollabOS.

You reason about creator partnerships. You do not manage schedules, send messages, or update records — CollabOS handles all execution. Your job is judgement and wording.

Non-negotiable rules:
- Use ONLY the data supplied in this message. Never invent audience metrics, engagement figures, replies, or collaboration history.
- If a fact is not supplied, say so rather than estimating it.
- Audience RELEVANCE and demonstrated RELIABILITY outweigh raw follower count. A smaller, well-matched audience is more valuable than a large mismatched one.
- Prohibited topics are hard boundaries set by the creator. A candidate touching one must be rejected, whatever their reach.
- Respond with JSON only. No prose before or after, no markdown fences.`;

function formatCreator(creator: CreatorProfile): string {
  return [
    `CREATOR PROFILE`,
    `  Name: ${creator.name}`,
    `  Niche: ${creator.niche}`,
    `  Target audience: ${creator.targetAudience}`,
    `  Brand voice: ${creator.brandVoice}`,
    `  PROHIBITED partnership topics (hard boundary): ${
      creator.prohibitedTopics.length ? creator.prohibitedTopics.join(", ") : "none"
    }`,
  ].join("\n");
}

function formatRelationship(relationship: Relationship | null): string[] {
  if (!relationship) {
    return [
      `  Relationship history: NONE — this creator has never worked with or contacted this partner.`,
    ];
  }

  const lines = [`  Relationship history:`, `    Status: ${relationship.status}`];

  if (relationship.collaborationCount > 0) {
    lines.push(`    Completed collaborations: ${relationship.collaborationCount}`);
  }
  if (relationship.previousResponse) {
    lines.push(`    Previous response: ${relationship.previousResponse}`);
  }
  if (relationship.rejectionReason) {
    lines.push(`    Reason given for declining: ${relationship.rejectionReason}`);
  }
  if (relationship.performanceScore !== null) {
    lines.push(
      `    Qualified-engagement score from past work: ${relationship.performanceScore} ` +
        `(0–1, creator-reported)`,
    );
  }
  if (relationship.reliabilityScore !== null) {
    lines.push(`    Reliability score: ${relationship.reliabilityScore} (0–1)`);
  }
  if (relationship.preferredCommunicationStyle) {
    lines.push(`    Preferred communication style: ${relationship.preferredCommunicationStyle}`);
  }
  if (relationship.lastContactedAt) {
    lines.push(
      `    Last contacted: ${relationship.lastContactedAt.toISOString().slice(0, 10)}`,
    );
  }
  if (relationship.optedOut) {
    lines.push(`    OPTED OUT: this partner must not be contacted again.`);
  }

  return lines;
}

function formatCandidate(candidate: CandidateContext, index: number): string {
  const { partner, safetyConflicts } = candidate;

  const lines = [
    `CANDIDATE ${index + 1}`,
    `  partnerId: ${partner.id}   <- use this exact string in your response`,
    `  Name: ${partner.name}`,
    `  Niche: ${partner.niche}`,
    `  Audience description: ${partner.audienceDescription}`,
    `  Audience size: ${partner.audienceSize.toLocaleString("en-US")} (context only — NOT a ranking criterion on its own)`,
    `  Collaboration preferences: ${partner.collaborationPreferences}`,
    `  Declared safety flags: ${
      partner.safetyFlags.length ? partner.safetyFlags.join(", ") : "none"
    }`,
    ...formatRelationship(candidate.relationship),
  ];

  if (safetyConflicts.length) {
    lines.push(
      `  ⚠ BRAND-SAFETY CONFLICT DETECTED BY COLLABOS: ${safetyConflicts.join("; ")}`,
      `    This candidate violates the creator's hard boundaries and must be ranked last with recommendation "reject".`,
    );
  }

  return lines.join("\n");
}

/**
 * Ranking request.
 *
 * `memoryUsed` is required in the response so the creator can see which remembered
 * facts drove each verdict — that is what distinguishes memory that *influences*
 * decisions from memory that merely exists.
 */
export function buildPartnerRankingPrompt(input: {
  creator: CreatorProfile;
  objective: string;
  candidates: CandidateContext[];
}): string {
  const { creator, objective, candidates } = input;

  return `${ROLE_HEADER}

TASK
Rank every candidate below for this growth objective and explain your reasoning.

GROWTH OBJECTIVE
  ${input.objective.trim()}

${formatCreator(creator)}

${candidates.map((candidate, index) => formatCandidate(candidate, index)).join("\n\n")}

HOW TO DECIDE
- Weight audience relevance to "${creator.targetAudience}" most heavily.
- Weight demonstrated reliability and past collaboration outcomes next.
- Treat a previous decline as a caution to acknowledge, not an automatic disqualification — unless the partner opted out, in which case they must be rejected.
- Reject any candidate conflicting with the prohibited topics, regardless of audience size.
- Do not reward a large audience that does not match the target audience.

RESPONSE FORMAT
Return ONLY this JSON object:

{
  "summary": "<one short paragraph explaining the overall ranking>",
  "recommendations": [
    {
      "partnerId": "<exact partnerId from above>",
      "rank": 1,
      "fitScore": 0,
      "recommendation": "recommended" | "consider" | "reject",
      "reasons": ["<specific, evidence-based reason>"],
      "risks": ["<specific risk, or omit if none>"],
      "memoryUsed": ["<each remembered fact you actually relied on>"]
    }
  ]
}

Requirements:
- Include ALL ${candidates.length} candidates.
- Use ranks 1..${candidates.length}, each exactly once. Rank 1 is the best partner.
- fitScore is an integer 0–100.
- "memoryUsed" must cite the supplied relationship history you relied on. Use an empty array only when a candidate genuinely has no history.
- Every string must be grounded in the data above.
${objective.length === 0 ? "" : ""}`;
}

/**
 * Repair instruction after a failed validation.
 *
 * Deliberately restates the exact problems rather than resending the original prompt,
 * and is used at most once (§11). If this also fails, CollabOS surfaces an error — it
 * never invents a valid response.
 */
export function buildRepairPrompt(input: {
  issues: string[];
  candidateIds: readonly string[];
  expectedCount: number;
}): string {
  return `Your previous response could not be used. It failed validation:

${input.issues.map((issue) => `  - ${issue}`).join("\n")}

Send the corrected response now. Requirements:
- JSON only. No markdown fences, no commentary.
- Exactly ${input.expectedCount} entries in "recommendations".
- "partnerId" must be one of these exact strings: ${input.candidateIds.join(", ")}
- Ranks must be 1..${input.expectedCount}, each used exactly once.
- "fitScore" must be an integer between 0 and 100.
- "reasons" must contain at least one entry per candidate.
- Do not add fields that were not requested. Do not invent data.`;
}

/**
 * Follow-up request for an overdue deliverable.
 *
 * Emphasis on "one reminder, already agreed" — CollabOS only ever sends a single
 * autonomous follow-up, and the wording must not read as unsolicited outreach.
 */
export function buildFollowUpPrompt(input: {
  creator: CreatorProfile;
  partner: Partner;
  relationship: Relationship | null;
  objective: string;
  deliverableTitle: string;
  deliverableDescription: string;
  dueAt: Date;
  now: Date;
}): string {
  const overdueMinutes = Math.max(
    0,
    Math.round((input.now.getTime() - input.dueAt.getTime()) / 60_000),
  );

  return `${ROLE_HEADER}

TASK
Compose ONE polite follow-up message about a deliverable that has passed its agreed deadline.

This is a reminder about work the partner already agreed to, not new outreach. It must be the only reminder sent. Do not imply consequences, do not chase aggressively, and do not invent a reply the partner has not sent.

CAMPAIGN
  Objective: ${input.objective.trim()}
  Deliverable: ${input.deliverableTitle}
  Description: ${input.deliverableDescription}
  Agreed deadline: ${input.dueAt.toISOString()}
  Currently overdue by: ${overdueMinutes} minute(s)

${formatCreator(input.creator)}

PARTNER
  Name: ${input.partner.name}
  Niche: ${input.partner.niche}
  Collaboration preferences: ${input.partner.collaborationPreferences}
${formatRelationship(input.relationship).join("\n")}

REQUIREMENTS
- Match ${input.creator.name}'s brand voice: ${input.creator.brandVoice}.
${
  input.relationship?.preferredCommunicationStyle
    ? `- Respect this partner's preferred communication style: ${input.relationship.preferredCommunicationStyle}.\n`
    : ""
}- Reference the shared history only if it is supplied above.
- Offer a way to flag a problem or ask for a short extension.
- Keep it under 150 words.

RESPONSE FORMAT
Return ONLY this JSON object:

{
  "subject": "<email subject line>",
  "body": "<the message body as plain text>",
  "rationale": "<why you chose this wording and tone>",
  "memoryUsed": ["<each remembered fact you relied on>"]
}`;
}

/** Brief request, issued once a partner has accepted. */
export function buildCampaignBriefPrompt(input: {
  creator: CreatorProfile;
  partner: Partner;
  relationship: Relationship | null;
  objective: string;
}): string {
  return `${ROLE_HEADER}

TASK
Write a short shared campaign brief for a confirmed collaboration between ${input.creator.name} and ${input.partner.name}.

Both people will read this brief, so keep it collaborative and concrete.

GROWTH OBJECTIVE
  ${input.objective.trim()}

${formatCreator(input.creator)}

PARTNER
  Name: ${input.partner.name}
  Niche: ${input.partner.niche}
  Audience: ${input.partner.audienceDescription}
  Collaboration preferences: ${input.partner.collaborationPreferences}
${formatRelationship(input.relationship).join("\n")}

REQUIREMENTS
- Respect the creator's brand voice and prohibited topics.
- Talking points must serve both audiences, not only the creator's.
- The success metric must be something the creator could actually observe. Do not invent a numeric target.

RESPONSE FORMAT
Return ONLY this JSON object:

{
  "title": "<short campaign title>",
  "summary": "<one paragraph both parties can align on>",
  "talkingPoints": ["<point>", "<point>", "<point>"],
  "toneNotes": "<how the collaboration should sound>",
  "successMetric": "<one observable measure of success>"
}`;
}

/**
 * Post-campaign debrief, asked once the creator approves the deliverable.
 *
 * The observed facts are supplied explicitly (on time or late, follow-up needed or not) and
 * the Mind is told plainly that no audience data exists. This is what stops a debrief
 * drifting into invented performance claims.
 */
export function buildCampaignDebriefPrompt(input: {
  creator: CreatorProfile;
  partner: Partner;
  relationship: Relationship | null;
  objective: string;
  submittedOnTime: boolean;
  neededFollowUp: boolean;
  hoursLate: number | null;
}): string {
  return `${ROLE_HEADER}

TASK
The collaboration is complete and the creator has approved the deliverable. Write a short debrief that will inform future partner recommendations.

WHAT ACTUALLY HAPPENED — these are the only outcome facts available
  Objective: ${input.objective.trim()}
  Partner: ${input.partner.name}
  Deliverable submitted on time: ${input.submittedOnTime ? "yes" : "no"}${
    input.hoursLate !== null && !input.submittedOnTime
      ? ` (${input.hoursLate.toFixed(1)} hours late)`
      : ""
  }
  Required an automated deadline reminder: ${input.neededFollowUp ? "yes" : "no"}

NO AUDIENCE DATA EXISTS. CollabOS has no analytics integration, so there are no view counts, follower changes, engagement rates, or conversion figures. Do NOT state, estimate, or imply any such number. If you refer to performance, refer only to the delivery facts above.

${formatCreator(input.creator)}

PARTNER
  Name: ${input.partner.name}
  Niche: ${input.partner.niche}
${formatRelationship(input.relationship).join("\n")}

RESPONSE FORMAT
Return ONLY this JSON object:

{
  "whatWorked": ["<observation grounded in the facts above>"],
  "whatToImprove": ["<observation, or an empty array if nothing>"],
  "futurePartnerGuidance": "<how this outcome should influence the next partner choice>",
  "memoryUsed": ["<each remembered fact you relied on>"]
}`;
}

/** First-contact outreach. Always creator-approved before it is sent. */
export function buildOutreachPrompt(input: {
  creator: CreatorProfile;
  partner: Partner;
  relationship: Relationship | null;
  objective: string;
  acceptUrl: string;
}): string {
  return `${ROLE_HEADER}

TASK
Draft the FIRST outreach message from ${input.creator.name} to ${input.partner.name} proposing a collaboration.

${input.creator.name} will review this draft before anything is sent. Write it as a genuine, specific invitation — not a template.

GROWTH OBJECTIVE
  ${input.objective.trim()}

${formatCreator(input.creator)}

PARTNER
  Name: ${input.partner.name}
  Niche: ${input.partner.niche}
  Audience: ${input.partner.audienceDescription}
  Collaboration preferences: ${input.partner.collaborationPreferences}
${formatRelationship(input.relationship).join("\n")}

REQUIREMENTS
- Open with something specific to this partner's work, drawn from the data above.
- Explain the mutual audience benefit honestly. Do not promise metrics.
- If there is shared history, acknowledge it naturally.
${
  input.relationship?.rejectionReason
    ? `- This partner declined once before ("${input.relationship.rejectionReason}"). Acknowledge it briefly and address it — do not pretend it did not happen.\n`
    : ""
}- Keep it under 180 words.
- End by inviting them to accept using this link, included verbatim: ${input.acceptUrl}

RESPONSE FORMAT
Return ONLY this JSON object:

{
  "subject": "<email subject line>",
  "body": "<message body as plain text, including the acceptance link>",
  "rationale": "<why this framing suits this partner>",
  "memoryUsed": ["<each remembered fact you relied on>"]
}`;
}
