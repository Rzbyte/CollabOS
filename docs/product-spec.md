# CollabOS — Product Specification

**Mind role:** Creator Partnership Director
**Hackathon:** Creative Minds Jam #1 · Track: Audience Growth & Engagement

> CollabOS is a persistent Creator Partnership Director that remembers creator relationships,
> finds aligned collaborators, brings approved partners into a trusted Mind Circle, coordinates
> the joint campaign, follows up autonomously, and learns which partnerships actually grow the
> audience.

**Tagline:** The creator chooses the relationship. CollabOS runs everything in between.

---

## 1. The problem

Creator collaborations transfer relevant audiences better than almost any paid channel. But the
operator work is manual end to end: find suitable partners, research their audience, write
personalised outreach, track replies, follow up, prepare a shared brief, coordinate deadlines
and revisions, collect deliverables, approve final work, and measure whether any of it helped.

Existing AI tools recommend creators and draft messages. They generally do not retain
relationship history, continue a workflow across sessions, admit trusted collaborators into the
same workspace, or follow up on their own.

**CollabOS is built to be an operator, not a recommendation chatbot.** It owns the loop between
the creator's approval points.

---

## 2. What it does

1. Recalls the creator's brand and relationship history.
2. Ranks compatible partners, explaining which remembered facts drove the ranking.
3. Waits for creator approval of the partner.
4. Waits for a **separate** creator approval before any external contact.
5. Sends Mind-authored outreach in the creator's voice.
6. Admits the accepted collaborator to the Mind's trusted Circle.
7. Creates a shared brief and a deliverable with a deadline.
8. Performs **one** autonomous follow-up when the deadline passes.
9. Requests final creator approval of the submitted work.
10. Completes the campaign and writes the outcome back into relationship memory.

---

## 3. The seeded scenario

**Creator — Maya**

| Field | Value |
| --- | --- |
| Niche | Web3 safety education |
| Target audience | Beginner crypto users taking their first self-custody steps |
| Brand voice | Calm, practical, evidence-based, non-hype |
| Prohibited partnerships | gambling, leverage trading, token shilling |
| Goal | Launch a wallet-safety educational video |

**Candidates** — deliberately arranged so a follower-count ranking gets it backwards:

| Partner | Niche | Audience | History | Expected verdict |
| --- | --- | --- | --- | --- |
| **Mira Chen** | Beginner-friendly Web3 tutorials | **48,000** | 1 collaboration, on time, engagement 0.82, reliability 0.95, prefers concise/practical | **Recommended** |
| **Alex Morgan** | Crypto market commentary | 210,000 | Declined once — scheduling conflict; reliability 0.55 | Consider with caution |
| **Nova Alpha** | High-risk trading calls | 540,000 | None | **Rejected** — brand-safety conflict |

Mira has the *smallest* audience and the *strongest* relationship. Nova has the largest audience
and a disqualifying flag. That inversion is what makes the reasoning observable rather than
merely asserted.

All three are synthetic records on the IANA-reserved `@example.com` domain, which cannot receive
mail.

---

## 4. What the hackathon requirements look like in the product

| Requirement | How it is demonstrated |
| --- | --- |
| **Memory** | Brand voice, target audience, prohibited topics, and full relationship history live in Postgres and are sent to the Mind as structured context. The Mind returns `memoryUsed` — the specific remembered facts it relied on — rendered as evidence in Partner Review. |
| **Continuity** | One durable conversation alias per creator, bound idempotently. Every session and worker run reuses it; the creator never re-explains the campaign. Campaign position lives in Postgres, so it survives independently of chat history. |
| **Autonomous follow-up** | A separate worker process polls `nextActionAt`. **There is no "Follow Up" button anywhere in the UI.** You can close the browser and it still fires. |
| **Minds integration depth** | The Mind performs partner ranking, outreach wording, brief authoring, follow-up wording, and the post-campaign debrief. Every prompt and reply is stored and viewable. |
| **Circle usage** | The approved collaborator is added to and removable from the Mind's Circle — the platform's real trust gate — verified before *and* after mutation. |
| **Human control** | Three enforced server-side gates: partner selection, first outreach, final deliverable. Approving a partner deliberately does not authorise contacting them. |
| **Verifiable execution** | Five separate lifecycle timestamps per action. A failed call keeps `attemptedAt` and never gains `executedAt`, so attempted and succeeded can never collapse. |

---

## 5. Interface

| View | Purpose |
| --- | --- |
| **Command Center** | Objective, active campaign and state, pending approvals, next autonomous action, cognition balance, recent actions by phase |
| **Partner Review** | Three candidate cards: audience fit, relationship history, fit score, verdict, reasons, risks, memory used, approve/reject. Raw audience size is small and muted, labelled "not a ranking criterion". |
| **Collaboration Room** | Participants, live Circle state, shared brief, deliverable and deadline, follow-up status, submission, final approval, timeline, exact messages sent |
| **Activity Log** | Chronological per-phase records, plus the raw Mind prompts and replies |
| **Report** | Why this partner, execution summary, observed delivery, relationship before/after, Mind debrief, and an explicit "what this report does not claim" |
| **`/collab/[token]`** | Minimal collaborator page — accept and submit only, reached by signed link, exposing none of the creator's private strategy |

---

## 6. Deliberate non-goals

Out of scope per `CLAUDE.md` §19: blockchain, tokens, NFTs, escrow, MENTE transfers, multi-chain,
public creator marketplace, multi-agent architecture, social scraping, multi-platform
auto-publishing, complex analytics, billing, production identity verification.

Additional MVP boundaries:

- **No audience-growth measurement.** CollabOS has no analytics integration, so it never produces
  a view count, follower delta, or engagement figure. Performance is creator-reported or absent.
- **No real message provider.** Email is a local test sink only.
- **No authentication.** Single seeded creator.
- **Synthetic partners only.** Audience figures are illustrative seed data, never presented as
  measured.

A verifiable collaboration receipt remains roadmap-only — see `docs/roadmap.md`.
