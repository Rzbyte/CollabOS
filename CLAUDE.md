# CollabOS — Claude Code Project Instructions

## Project Identity

**Product:** CollabOS  
**Mind role:** Creator Partnership Director  
**Hackathon:** Creative Minds Jam #1  
**Track:** Audience Growth & Engagement

### Core positioning

> CollabOS is a persistent Creator Partnership Director that remembers creator relationships, finds aligned collaborators, brings approved partners into a trusted Mind Circle, coordinates the joint campaign, follows up autonomously, and learns which partnerships actually grow the audience.

### Primary tagline

> The creator chooses the relationship. CollabOS runs everything in between.

### Demo closing line

> CollabOS didn’t recommend a collaboration. It ran one.

---

## 1. Mission

Build a working hackathon product that manages creator collaborations from growth objective to completed campaign.

CollabOS must behave as an operator, not a recommendation chatbot.

A creator should be able to submit one objective such as:

> Run a collaboration to grow the launch of my next video.

CollabOS must then:

1. Recall the creator’s brand and relationship history.
2. Rank compatible creator partners.
3. Wait for creator approval.
4. Prepare approved personalized outreach.
5. Track replies across sessions.
6. Add an accepted collaborator to the Mind’s trusted Circle.
7. Create a campaign brief and deliverables.
8. Coordinate deadlines and revisions.
9. Perform one autonomous follow-up when overdue.
10. Request final creator approval.
11. Complete the campaign.
12. Update relationship history and future partner recommendations.

---

## 2. Problem

Creator collaborations can transfer relevant audiences, but creators must manually:

- Find suitable partners.
- Research their audience and content.
- Write personalized outreach.
- Track replies.
- Follow up.
- Prepare a shared brief.
- Coordinate deadlines and revisions.
- Collect deliverables.
- Approve final work.
- Measure whether the partnership produced useful audience growth.

Existing AI tools may recommend creators or draft messages, but they usually do not retain relationship history, continue a workflow across sessions, admit trusted collaborators into the same workspace, or autonomously follow up.

CollabOS must own the operational loop between creator approval points.

---

## 3. Hackathon Requirements to Prove

The working product must visibly demonstrate:

### Memory

The Mind remembers:

- Creator identity.
- Brand voice.
- Target audience.
- Prohibited topics.
- Previous partner interactions.
- Rejections.
- Reliability.
- Prior campaign outcomes.

Memory must influence decisions, not merely appear in chat history.

### Continuity

A campaign continues across separate sessions without requiring the creator to repeat its context.

### Autonomous follow-up

A server-side worker triggers a contextual follow-up when a reply or deliverable becomes overdue.

There must be no manual “Follow Up” button used to fake autonomy.

### Minds integration depth

Minds must be integral to:

- Partner-fit reasoning.
- Relationship context.
- Context-aware communication.
- Campaign continuity.
- Follow-up wording and reasoning.

### Circle usage

An approved external human collaborator can be added to and removed from the Mind’s Circle.

### Human control

Creator approval is required for:

- Partner selection.
- First external outreach.
- Final deliverable.
- Publishing.
- Payments.
- Destructive actions.
- Any onchain action.

### Verifiable execution

Every action must distinguish:

- Proposed.
- Approved.
- Attempted.
- Succeeded.
- Failed.

All states must appear in the audit log.

---

## 4. Core Demo Scenario

Use this seeded scenario.

### Creator

- Name: Maya
- Niche: Web3 safety education
- Target audience: beginner crypto users
- Brand voice: calm, practical, evidence-based, non-hype
- Prohibited partnerships: gambling, leverage trading, token shilling
- Goal: launch a wallet-safety educational video

### Partner candidates

#### Mira Chen

- Niche: beginner-friendly Web3 tutorials
- Strong audience alignment
- Completed one previous collaboration on time
- Produced the strongest qualified engagement
- Preferred communication style: concise and practical

#### Alex Morgan

- Niche: crypto market commentary
- Larger audience but weaker audience alignment
- Previously rejected a collaboration because of scheduling conflicts

#### Nova Alpha

- Niche: high-risk trading calls
- Large audience
- Conflicts with Maya’s prohibited topics
- Must not be recommended as a safe partnership

### Expected Mind behavior

- Recommend Mira first.
- Explain why audience relevance and relationship history outweigh raw follower count.
- Treat Alex cautiously because of prior rejection and weaker fit.
- Reject or heavily flag Nova Alpha because of brand-safety constraints.
- Never invent metrics, replies, or campaign history beyond seeded data.

---

## 5. Winning Vertical Slice

Build this workflow before adding anything else:

1. Maya submits a growth objective.
2. The backend loads Maya’s profile and three curated candidates.
3. The backend sends structured context to the Creator Partnership Director Mind.
4. The Mind ranks the candidates and returns structured explanations.
5. Maya approves Mira.
6. The system creates an approval record.
7. The system adds the controlled collaborator email to the Mind’s Circle.
8. The system creates a campaign brief and one deliverable.
9. The campaign enters `awaiting_deliverable`.
10. In development mode, the deliverable deadline is three minutes.
11. A server-side worker detects the overdue deliverable.
12. The worker asks the Mind for a context-aware follow-up.
13. The system sends the follow-up through a clearly labeled local test transport.
14. The system records all execution states in the activity log.
15. A collaborator submits a deliverable.
16. Maya approves it.
17. The campaign becomes `completed`.
18. The result updates the persistent relationship record.

This entire sequence must be demonstrable from the UI.

---

## 6. Architecture Principle

### Minds owns relationship intelligence

- Creator and brand context.
- Relationship memory.
- Partner-fit reasoning.
- Context-aware communication.
- Campaign continuity.
- Follow-up wording and reasoning.

### CollabOS owns deterministic execution

- Campaign state machine.
- Database records.
- Scheduling.
- Approval enforcement.
- Circle mutations.
- External message transport.
- Deliverable status.
- Metrics.
- Audit logs.
- Retries.
- Idempotency.

### Core rule

> Minds owns contextual memory. CollabOS owns operational state.

Never rely solely on chat history as the operational database.

---

## 7. Required Stack

Use:

- Node.js 22 or newer.
- Next.js App Router.
- TypeScript strict mode.
- PostgreSQL.
- Prisma ORM.
- `@animocabrands/minds-client-lib`.
- Zod for runtime validation.
- Tailwind CSS.
- Docker Compose for local PostgreSQL.
- Mailpit or another clearly labeled local email test transport.
- Vitest or Jest.
- Playwright for one critical end-to-end test when practical.

Do not silently replace PostgreSQL with SQLite.

If the repository is empty, initialize it.

If code already exists, inspect it before changing anything and preserve working conventions unless they conflict with this specification.

---

## 8. Minds Setup and CLI Validation

First inspect installed versions:

```bash
node --version
npm --version
npm view @animocabrands/minds-cli dist-tags --json
```

If the `beta` dist-tag exists:

```bash
npm install -g @animocabrands/minds-cli@beta
```

Otherwise:

```bash
npm install -g @animocabrands/minds-cli@latest
```

Then run:

```bash
minds --version
minds doctor --pretty
minds --help
minds list --pretty
minds circle --help
minds cognition --help
minds usage --help
minds bazaar --help
```

Treat the installed CLI’s `--help` output as the source of truth.

Save a sanitized smoke-test summary in:

```text
docs/minds-smoke-test.md
```

Never commit API keys or full sensitive responses.

---

## 9. Environment Variables

Create `.env.example`:

```env
MINDS_BUILDER_API_KEY=
MINDS_MIND_ID=
COLLABORATOR_TEST_EMAIL=
DATABASE_URL=postgresql://collabos:collabos@localhost:5432/collabos
APP_URL=http://localhost:3000
EMAIL_TRANSPORT=mailpit
MAILPIT_HOST=localhost
MAILPIT_SMTP_PORT=1025
FOLLOW_UP_DELAY_SECONDS=180
```

Requirements:

- Validate required variables at application startup.
- Keep the Minds API key server-side.
- Add secret files to `.gitignore`.
- Never print secrets in logs, tests, screenshots, README files, or error messages.

---

## 10. Minds Client Integration

Prefer the official Node client library.

Install:

```bash
npm install @animocabrands/minds-client-lib
```

Create a server-only wrapper such as:

```text
src/lib/minds/client.ts
```

The wrapper should support, when available through the current official package or API:

- Validating the configured Mind.
- Sending messages.
- Waiting for replies.
- Reading relevant conversation history.
- Getting cognition balance.
- Reading Circle membership.
- Adding a human collaborator to a Circle.
- Removing a human collaborator from a Circle.
- Typed error handling.
- Timeouts.
- Bounded retries.
- Correlation IDs.

Use installed package types and official documentation as the contract.

Do not invent client methods.

If a capability is not available in the installed package, inspect official Builder API documentation before implementing a narrow HTTP adapter. Document the reason.

Do not execute CLI commands from normal production request handlers unless there is no supported client or HTTP method.

---

## 11. Structured Mind Output

Do not parse unstructured prose for important state transitions.

Create a Zod schema similar to:

```ts
type PartnerRecommendation = {
  partnerId: string;
  rank: number;
  fitScore: number;
  recommendation: "recommended" | "consider" | "reject";
  reasons: string[];
  risks: string[];
  memoryUsed: string[];
};
```

Ask the Mind to return JSON matching the schema.

Validation behavior:

1. Validate the response.
2. If invalid, record the failure.
3. Retry once with a repair instruction.
4. Never fabricate a valid response.
5. Surface an actionable error in the UI.

---

## 12. Campaign State Machine

Implement explicit states:

```text
draft
objective_submitted
partners_recommended
partner_approved
outreach_approval_required
outreach_approved
outreach_sent
partner_accepted
circle_add_pending
circle_added
campaign_active
awaiting_deliverable
follow_up_due
follow_up_generating
follow_up_sent
deliverable_received
final_approval_required
completed
cancelled
failed
```

State transitions must be:

- Explicit.
- Validated.
- Idempotent.
- Tested.
- Recorded in the audit log.
- Rejected when illegal.

Do not update campaign states directly from arbitrary UI code.

Create a dedicated transition service.

---

## 13. Minimum Database Models

### CreatorProfile

- id
- name
- niche
- targetAudience
- brandVoice
- prohibitedTopics
- mindConversationAlias or conversation ID
- createdAt
- updatedAt

### Partner

- id
- name
- email
- niche
- audienceDescription
- collaborationPreferences
- reliabilityScore
- safetyFlags
- isSynthetic
- createdAt
- updatedAt

### Relationship

- id
- creatorId
- partnerId
- status
- previousResponse
- rejectionReason
- collaborationCount
- performanceScore
- reliabilityScore
- preferredCommunicationStyle
- lastContactedAt
- createdAt
- updatedAt

### Campaign

- id
- creatorId
- objective
- status
- approvedPartnerId
- deadline
- nextActionAt
- followUpCount
- createdAt
- updatedAt

### PartnerRecommendation

- id
- campaignId
- partnerId
- rank
- fitScore
- recommendation
- reasons
- risks
- memoryUsed
- rawMindResponseReference
- createdAt

### Approval

- id
- campaignId
- actionType
- payload
- status
- requestedAt
- approvedAt
- rejectedAt

### Deliverable

- id
- campaignId
- title
- description
- status
- dueAt
- submittedAt
- approvedAt
- submissionUrl or local test reference

### AgentAction

- id
- campaignId
- correlationId
- actionType
- reason
- status
- requiresApproval
- proposedAt
- approvedAt
- attemptedAt
- executedAt
- failedAt
- externalReference
- errorCode
- sanitisedErrorMessage

### CircleMembership

- id
- campaignId
- mindId
- collaboratorEmail
- status
- addedAt
- removedAt
- externalReference

---

## 14. UI

Build a polished but narrow interface.

Do not build a generic admin dashboard with irrelevant widgets.

### A. Command Center

Show:

- Creator growth objective.
- Active campaign.
- Current state.
- Pending creator approvals.
- Next autonomous action and scheduled time.
- Cognition balance.
- Latest completed agent actions.
- Clear distinction between proposed, approved, attempted, succeeded, and failed.

### B. Partner Review

Show candidate cards containing:

- Name and niche.
- Audience fit.
- Relationship history.
- Fit score.
- Recommendation.
- Reasons.
- Risks.
- Memory used.
- Approve and reject controls.

Raw follower size must not dominate the design.

### C. Collaboration Room

Show:

- Creator and partner.
- Circle membership state.
- Shared campaign brief.
- Deliverable.
- Deadline.
- Follow-up status.
- Submission.
- Final approval.
- Timeline.

### D. Agent Activity Log

Show chronological records such as:

```text
09:10 — Loaded creator brand memory
09:11 — Evaluated three partner candidates
09:12 — Recommended Mira using previous campaign history
09:18 — Creator approved Mira
09:19 — Circle invitation attempted
09:20 — Mira added to trusted Circle
09:21 — Campaign brief created
09:24 — Deliverable became overdue
09:24 — Autonomous follow-up generation started
09:25 — Follow-up sent through Mailpit test transport
```

Clearly label test or simulated transports.

Never present a mocked action as a real external action.

---

## 15. Autonomous Follow-up Worker

Implement a worker or scheduled process that:

1. Queries campaigns whose `nextActionAt` has passed.
2. Claims or locks work to prevent duplicate execution.
3. Checks the campaign is still awaiting the expected action.
4. Ensures no more than one autonomous follow-up is sent.
5. Checks the partner has not rejected or opted out.
6. Loads creator, partner, relationship, and campaign context.
7. Requests a contextual follow-up from the Mind.
8. Validates the response.
9. Sends it through the configured transport.
10. Records attempted, successful, or failed execution separately.
11. Advances state only after confirmed success.
12. Uses bounded retries.
13. Is idempotent.

Provide a development command for running the worker locally.

---

## 16. Circle Management

Use a controlled tester email from:

```env
COLLABORATOR_TEST_EMAIL=
```

Requirements:

- Add only after creator approval.
- Do not accept arbitrary Circle emails directly from unauthenticated browser input.
- Verify current Circle membership before mutation.
- Treat “already exists” as idempotent success.
- Store returned results.
- Support removal after completion or cancellation.
- Show Circle state in the UI.
- Provide an emergency cleanup command.
- Circles are for human collaborator emails only.
- Do not attempt Mind-to-Mind Circle membership.

If Circle mutation fails, the campaign must not falsely display `circle_added`.

---

## 17. Email and Collaborator Test Flow

For the first milestone:

- Use Mailpit for outreach and follow-up delivery.
- Clearly label it “Local test transport.”
- Include a signed local acceptance link.
- Allow a tester to accept the collaboration.
- Allow the tester to submit a deliverable through a minimal collaborator page.
- Do not claim Instagram, X, TikTok, or YouTube messages were sent.
- Do not embed X in an iframe.
- Do not scrape social platforms.

Create a transport interface so a real provider can be added later without changing campaign logic.

---

## 18. Safety Rules

### Safe autonomous actions

- Research curated candidates.
- Generate recommendations.
- Create internal briefs.
- Update internal campaign status.
- Send one previously authorized deadline follow-up.
- Remind participants about an agreed deliverable.

### Creator approval required

- Choosing the partner.
- First external outreach.
- Adding an external collaborator when the intended person is ambiguous.
- Publishing content.
- Changing campaign terms.
- Sending payment.
- Recording anything onchain.
- Removing access when there is ambiguity.

### Prohibited

- Repeated unsolicited outreach.
- Contacting rejected or opted-out partners.
- Fabricating replies.
- Fabricating campaign metrics.
- Fabricating Circle success.
- Sharing private creator information.
- Sending financial transactions.
- Creating tokens, NFTs, or escrow.
- Multi-agent orchestration in the MVP.
- Scraping private or restricted platform data.

---

## 19. Out of Scope

Do not build:

- Blockchain integrations.
- Tokens.
- NFTs.
- Escrow.
- MENTE transfers.
- Multi-chain support.
- Public creator marketplace.
- Multi-agent architecture.
- Social-platform scraping.
- Automatic publishing to several platforms.
- Complex analytics.
- Billing.
- Production identity verification.

A verifiable collaboration receipt may remain in the roadmap only.

---

## 20. Tests

### Unit tests

- Legal campaign transitions.
- Illegal campaign transitions.
- Maximum one autonomous follow-up.
- Rejected partner cannot be contacted.
- Brand-safety candidate is rejected or flagged.
- Idempotent Circle addition.
- Idempotent worker execution.
- Zod validation and repair failure.

### Integration tests

- Seeded objective to partner recommendations.
- Partner approval to Circle add attempt.
- Overdue deliverable to autonomous follow-up.
- Deliverable submission to final approval.
- Campaign completion updates relationship history.
- Failed external action does not produce false success state.

### End-to-end test

Build one Playwright flow covering:

```text
Submit objective
→ review candidates
→ approve Mira
→ approve first outreach
→ accept as collaborator
→ show Circle state
→ trigger deterministic test clock
→ observe autonomous follow-up
→ submit deliverable
→ approve deliverable
→ complete campaign
```

Use fake timers or an injectable clock in tests.

Do not make automated tests wait three real minutes.

---

## 21. Required Documentation

Create:

```text
README.md
CLAUDE.md
docs/product-spec.md
docs/implementation-plan.md
docs/architecture.md
docs/minds-smoke-test.md
docs/security-and-approvals.md
docs/demo-script.md
docs/test-plan.md
docs/known-limitations.md
docs/roadmap.md
```

README must explain:

- What CollabOS is.
- Why Minds is integral.
- How memory, continuity, Circle, and autonomy are demonstrated.
- Local setup.
- Environment variables.
- Database setup.
- Mailpit setup.
- Minds smoke testing.
- Running the app.
- Running the worker.
- Running tests.
- Which actions are real.
- Which actions use test transport.
- Current limitations.

---

## 22. Milestones

Execute in this order.

### Milestone 0 — Repository and documentation inspection

- Inspect all files.
- Read package manifests and existing docs.
- Read official references.
- Write `docs/implementation-plan.md`.
- Identify missing credentials without exposing them.
- Do not ask unnecessary questions when a safe default is available.

### Milestone 1 — Minds platform proof

- Validate Node 22+.
- Validate CLI version.
- Run `minds doctor`.
- List Minds.
- Validate configured Mind ID.
- Check cognition balance.
- Read Circle state.
- Send a safe test message.
- Record sanitized results.

### Milestone 2 — Foundation

- Initialize or repair Next.js project.
- Add PostgreSQL and Mailpit Docker Compose.
- Create Prisma schema and migrations.
- Add seed data.
- Add environment validation.
- Add Minds server wrapper.
- Add audit logging.
- Add campaign state machine.

### Milestone 3 — Recommendation and approval

- Objective form.
- Structured Mind recommendation.
- Partner Review UI.
- Approve/reject flow.
- Approval records.
- Activity log.

### Milestone 4 — Circle and campaign

- Add approved collaborator to Circle.
- Show Circle state.
- Create brief and deliverable.
- Collaboration Room.
- Controlled acceptance flow.

### Milestone 5 — Autonomous follow-up

- Scheduler or worker.
- Three-minute development deadline.
- Context-aware follow-up.
- Mailpit delivery.
- Idempotency.
- Audit records.
- UI live update or polling.

### Milestone 6 — Completion loop

- Deliverable submission.
- Final creator approval.
- Campaign completion.
- Relationship history update.
- Campaign report.

### Milestone 7 — Quality and demo polish

- Tests.
- Empty/loading/error states.
- Accessibility basics.
- Responsive demo layout.
- Seed reset command.
- Demo mode command.
- Documentation.
- Two-minute demo script.

---

## 23. Quality Gates

Before declaring any milestone complete, run the relevant checks.

Final checks must include:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Run the end-to-end test when configured.

Do not declare success when a command fails.

Fix the root cause or document the precise blocker.

---

## 24. Working Protocol

At the beginning of every Claude Code session:

1. Read this `CLAUDE.md` completely.
2. Inspect the current repository state.
3. Read `docs/implementation-plan.md` if it exists.
4. Check `git status`.
5. Review current test and build results.
6. Continue from the first incomplete milestone.
7. Do not redo completed work unnecessarily.
8. Do not perform destructive external actions without explicit user approval.
9. Update documentation when architecture or platform limitations change.

During implementation:

- Inspect before editing.
- Prefer small, reviewable changes.
- Maintain a running implementation checklist.
- Report discovered platform limitations.
- Do not overclaim.
- Do not invent APIs.
- Verify current CLI flags through `--help`.
- Use official TypeScript types.
- Keep secrets server-side.
- Do not publish a Skill to Bazaar during early development.
- Do not unpublish or mutate an existing Skill without explicit approval.
- Do not send real unsolicited outreach.
- Do not add blockchain.
- Do not stop at a static mockup.
- Do not hide failed integrations behind mocks.
- Clearly label every mock and local transport.
- Preserve an audit trail for every action.

When credentials are missing:

- Create `.env.example`.
- Implement the integration boundary.
- Keep the UI honest about the disconnected state.
- Continue work that does not require the missing secret.
- Provide an exact manual setup checklist.

---

## 25. Definition of Done

The first winning vertical slice is complete only when:

1. Maya submits a wallet-safety launch objective.
2. The Mind recommends Mira over Alex and Nova using seeded relationship and brand context.
3. Maya approves Mira.
4. The controlled collaborator is added to the Mind’s Circle.
5. The campaign brief and deliverable are created.
6. The deliverable becomes overdue.
7. A worker triggers one follow-up without a manual follow-up button.
8. The Mind produces contextual wording.
9. The message is delivered through the clearly labeled test transport.
10. The collaborator submits the deliverable.
11. Maya approves it.
12. The campaign completes.
13. Relationship history is updated.
14. The activity log proves every step.
15. Attempted and successful actions are distinguished.
16. The app passes lint, type checking, tests, and production build.

---

## 26. Official and Relevant References

Use official documentation and installed package types as the primary source of truth.

Treat community examples and open-source repositories only as inspiration.

### Hackathon

- DoraHacks event:  
  https://dorahacks.io/hackathon/creativeminds/details

- Creative Minds Jam official site:  
  https://creativemindsjam.com/

- Animoca Brands announcement:  
  https://www.animocabrands.com/announcement/the-sandbox-and-animoca-brands-launch-creative-minds-jam-1-hong-kong-usd10000-agentic-ai-competition

### Minds platform

- Minds:  
  https://hellominds.ai/

- Minds profile and Mind management:  
  https://hellominds.ai/profile

- Bazaar:  
  https://hellominds.ai/bazaar

- Builder documentation home:  
  https://build.hellominds.ai/en/docs

- Account setup:  
  https://build.hellominds.ai/en/docs/get-started/account-setup

- Minds CLI:  
  https://build.hellominds.ai/en/docs/get-started/cli

- Minds Client Library:  
  https://build.hellominds.ai/en/docs/get-started/client-library

- Circle guide:  
  https://build.hellominds.ai/en/docs/guides/circles

- Skill Building Guide:  
  https://build.hellominds.ai/en/docs/guides/building-skills

- Telegram connection:  
  https://build.hellominds.ai/docs/guides/telegram

- Builder FAQ:  
  https://build.hellominds.ai/en/faq

- Changelog:  
  https://build.hellominds.ai/en/changelog

- Minds Investment Programme:  
  https://build.hellominds.ai/program

- Investment Programme application:  
  https://build.hellominds.ai/program/apply

### Official inspiration

- Etsy Shop Strategist:  
  https://build.hellominds.ai/en/inspirations/etsy-shop-strategist

- Superior Trade Intern:  
  https://build.hellominds.ai/inspirations/superior-trade-intern

- AI Genealogist / Architect of Ancestry:  
  https://build.hellominds.ai/en/inspirations/architect-of-ancestry

### Optional orchestration reference

- DiscoCentaur:  
  https://github.com/justinquidli/discocentaur

### Packages

- CLI: `@animocabrands/minds-cli`
- Node client library: `@animocabrands/minds-client-lib`

---

## 27. First Session Instruction

After reading this file:

1. Inspect the repository.
2. Read the official reference URLs relevant to Milestones 0 and 1.
3. Check Node and npm.
4. Check available Minds CLI dist-tags.
5. Create `docs/implementation-plan.md`.
6. Execute Milestone 1.
7. Continue through work that does not require missing credentials.
8. Stop only when a destructive external action or genuinely unavailable credential blocks progress.

Before major implementation, report:

- Repository status.
- Detected environment.
- Implementation plan.
- Genuine blockers or required credentials.
