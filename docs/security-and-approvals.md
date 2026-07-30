# Security and Approvals

How CollabOS enforces `CLAUDE.md` §16–§18: what the agent may do alone, what needs the
creator, and what it must never do.

---

## 1. The approval matrix

### Safe autonomous actions — no human in the loop

| Action | Where |
| --- | --- |
| Load creator brand memory and relationship history | `service.ts` → `memory.loaded` |
| Ask the Mind to rank curated candidates | `service.ts` → `mind.partner_ranking` |
| Author the shared campaign brief | `collaboration.ts` → `mind.campaign_brief` |
| Create the deliverable and its deadline | `collaboration.ts` → `deliverable.created` |
| Update internal campaign status | `transition.ts` |
| Send **one** previously authorised deadline follow-up | `worker/follow-up.ts` → `followup.send` |
| Post-campaign debrief | `completion.ts` → `mind.campaign_debrief` |

Every one of these is recorded with `autonomous: true` where a human was genuinely absent at
execution time, so the Activity Log distinguishes them at a glance.

### Creator approval required — enforced server-side

| Gate | Enforcement |
| --- | --- |
| **Choosing the partner** | `approvePartner()`; campaign cannot leave `partners_recommended` without an `Approval` row |
| **First external outreach** | A *separate* gate. `approvePartner` transitions to `outreach_approval_required` and opens a second pending approval. Approving a partner never authorises contacting them. |
| **Final deliverable** | `approveDeliverable()`; campaign cannot reach `completed` without it |
| Publishing content | Out of scope — CollabOS publishes nothing |
| Changing campaign terms | Only via `rejectDeliverable` (revision), which is a creator action |
| Payment / onchain | Out of scope — no such capability exists in the codebase |
| Removing Circle access | Manual control in the Collaboration Room; never automatic on completion |

The two-gate split for partner-then-outreach is deliberate and tested: `approvePartner`
transitions *through* `partner_approved` straight to `outreach_approval_required`, so there is
no state in which a partner is approved and contactable without a second decision.

### Prohibited — structurally impossible or explicitly blocked

| Prohibition | How it is prevented |
| --- | --- |
| Repeated unsolicited outreach | One outreach (approval-gated) + at most one follow-up (three-layer cap) |
| Contacting a rejected or opted-out partner | `isPartnerRejectedForCampaign()` and `relationship.optedOut` checked in `approvePartner`, `approveAndSendOutreach`, **and** the worker |
| Fabricating replies | Acceptance only via the signed collaborator link; the system never synthesises a partner response |
| Fabricating campaign metrics | No analytics integration exists. `creatorReportedPerformance` is nullable and only ever written from explicit human input |
| Fabricating Circle success | `addCircleMember` re-reads the Circle after mutating and throws if the member is absent; failure stores `failed`, never `active` |
| Sharing private creator information | Collaborator page renders no prohibited topics, fit scores, rival candidates, or reliability scores |
| Financial transactions / tokens / NFTs / escrow | No such code exists |
| Multi-agent orchestration | Single Mind, single conversation alias |
| Scraping platform data | No HTTP client targets any social platform |

---

## 2. Brand safety

Enforced **twice**, because a hard boundary must not depend on a model reaching the right
conclusion:

1. The prompt states the prohibited topics as non-negotiable and flags any detected conflict
   inline for that candidate.
2. `assessPartnerSafety()` independently computes the conflict from
   `creator.prohibitedTopics` × `partner.safetyFlags` and **overrides** the Mind's verdict to
   `reject` if it disagreed.

An override writes a `safety.override` audit action rather than being applied silently.
Approving a blocked partner throws `BrandSafetyViolationError` server-side; the UI replaces the
approve control instead of merely disabling it.

Matching normalises separators and case, so the creator's prose (`"leverage trading"`) collides
with stored identifiers (`"leverage_trading"`). Empty strings are ignored — a naive substring
check would otherwise match everything.

---

## 3. Secret handling

- `MINDS_BUILDER_API_KEY` is read only in server modules. No variable is `NEXT_PUBLIC_`.
- `src/lib/minds/client.ts` throws if imported into a browser bundle.
- `sanitiseErrorMessage()` redacts JWT-shaped values, `Authorization`/`X-Api-Key` header
  assignments, and any remaining 40+ character opaque token — then additionally string-replaces
  the live key if it appears verbatim. Applied before any message is logged, stored on an
  `AgentAction`, or rendered.
- `.env` is gitignored; `.env.example` carries no values.
- `docs/minds-smoke-test.md` is generated with Circle email addresses masked and no key
  material.

Tested: a JWT embedded in a Mind error does not survive into
`AgentAction.sanitisedErrorMessage`.

---

## 4. Circle management (§16)

| Requirement | Implementation |
| --- | --- |
| Add only after creator approval | `addApprovedCollaboratorToCircle` verifies an `approved` `partner_selection` row exists in the database, not just campaign state |
| No arbitrary emails from browser input | The address comes **only** from `COLLABORATOR_TEST_EMAIL`. The signed token carries no email. |
| Verify membership before mutation | `getCircle()` before `addCircleMembers` |
| "Already exists" is idempotent success | Detected by the **pre-mutation** `getCircle()` read, which returns `already_member` early. Not from the platform summary — see the note below. |
| Store the returned result | Sanitised summary in `CircleMembership.externalReference` |
| Support removal | `removeCollaboratorFromCircle` + Room control on terminal campaigns |
| Show Circle state in the UI | Room reads **live** platform state each render |
| Emergency cleanup | `npm run circle:cleanup` — dry-run by default, requires `--yes` |
| Human emails only | `assertHumanCollaboratorEmail` rejects `@hellominds.ai` before any network call |
| Failure must not display `circle_added` | Failure stores `failed` and leaves the campaign at `circle_add_pending`, with no brief or deliverable created behind it |

When the platform Circle cannot be read, the Room marks the stored row "Unverified right now"
rather than presenting the last known status as current fact.

### The mutation summary cannot be trusted

Verified against the live platform on 2026-07-30. A Circle add that genuinely created a new
party (`partyId 578d31f5-…`, confirmed independently via `minds circle show`) returned:

```json
{"activated":0,"deactivated":0,"notInCircle":0,"mindsAdded":0,
 "humansAdded":0,"humansCreatedAndAdded":0,"alreadyInCircle":0,"totalProcessed":0}
```

Every counter is zero on a **successful** mutation. Any implementation using
`summary.humansAdded > 0` or `totalProcessed > 0` as its success signal would report failure on
a working add and strand the campaign at `circle_add_failed`.

CollabOS is safe from this because success is defined as "the platform lists the member when we
read the Circle back", not "the platform said it did something". The summary is stored on
`CircleMembership.externalReference` for audit and nothing else.

---

## 5. The unauthenticated collaborator surface

The collaborator page has no login, so the signed link is the credential.

- HMAC-SHA256 over a compact payload, compared with `timingSafeEqual`.
- Signature is verified **before** the payload is parsed, so a tampered payload cannot
  influence which error is reported.
- 30-day expiry, checked against the injectable clock.
- The token carries **only** a campaign id — no email, no role, no permission to name a Circle
  member.
- Exactly two operations are reachable: accept, and submit a deliverable.
- The campaign id comes from the verified token, never from a form field, so a visitor cannot
  act on a campaign they were not given a link to.

---

## 6. Email

There is **no real-provider transport in this build, by design.** `EMAIL_TRANSPORT` accepts only
`mailpit` or `console`, both local sinks. Mailpit does not relay, so even a real address in
`to:` receives nothing.

Every send carries `isTestTransport: true`, and that flag propagates to the audit row and the UI
label — so the label cannot drift out of sync with reality. Messages also carry
`X-CollabOS-Transport: mailpit-local-test` headers.

No social platform is contacted, named as a delivery channel, embedded, or scraped.

---

## 7. The offline fixture Mind

`COLLABOS_UNSAFE_FIXTURE_MIND=1` swaps in canned Mind responses so the Playwright end-to-end
test can run without credentials. This is a labelled test seam, not the hidden mock §24
forbids:

- Named "unsafe" so it is not enabled casually.
- **Throws** under `NODE_ENV=production` rather than degrading quietly.
- Every page renders a permanent red `role="alert"` banner while active.
- Every exchange is persisted with `fixtureMode: true` and badged in the Activity Log, so a
  canned reply is identifiable forever.
- Logs a warning to the server console on construction.
- Returns a cognition balance of `0` rather than a plausible-looking number.

**It must never be used for a demo, a screenshot presented as real, or as evidence that the
Minds integration works.** The real integration's round trip is genuinely unverified until a
Builder API key exists; that is recorded in `docs/known-limitations.md`.

---

## 8. What a security review should still flag

- **No authentication.** Single seeded creator; every browser session is "Maya". The approval
  gates are enforced server-side but there is no notion of *who* approved. Any multi-tenant
  deployment needs real auth before the gates mean anything.
- **No CSRF beyond framework defaults.** Server Actions provide origin checks; nothing further
  was added.
- **No rate limiting** on the public collaborator route.
- **`LINK_SIGNING_SECRET` has a development default.** Documented, and any shared environment
  must set it explicitly.
- **`npm audit` reports upstream advisories** in `eslint`→`brace-expansion` and
  `next`→`postcss`/`sharp` at their latest published versions. Accepted for a local hackathon
  build with no untrusted input; would need revisiting before public deployment.
