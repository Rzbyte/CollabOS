# CollabOS Architecture

The governing rule, from `CLAUDE.md` §6:

> **Minds owns contextual memory. CollabOS owns operational state.**

Concretely: the Mind is never asked to remember an operational fact, and Postgres is never
asked to produce a judgement.

---

## 1. Responsibility split

| Minds owns — relationship intelligence | CollabOS owns — deterministic execution |
| --- | --- |
| Partner-fit reasoning | Campaign state machine |
| Which remembered facts mattered | Database records |
| Outreach and follow-up wording | Scheduling and the worker |
| Shared brief authoring | Approval enforcement |
| Post-campaign debrief guidance | Circle mutations, transport |
| Cross-session conversation continuity | Audit log, retries, idempotency |

Two consequences worth stating:

- **Chat history is never the operational database.** Campaign state lives in Postgres. If the
  Mind were wiped tomorrow, every campaign's position, deadline, approval, and audit trail
  would survive.
- **Postgres never makes a judgement.** There is no scoring heuristic deciding which partner
  is best. The one derived number CollabOS computes — reliability — is documented as derived,
  from facts it observed.

---

## 2. Process topology

```text
┌──────────────────── Next.js App Router (RSC) ────────────────────┐
│  Command Center · Partner Review · Collaboration Room            │
│  Activity Log · Report · /collab/[token] (unauthenticated)       │
│                                                                  │
│  Server Actions only. No UI code writes campaign.status.         │
└───────────┬──────────────────────────────────┬──────────────────┘
            │                                  │
   ┌────────▼─────────┐              ┌─────────▼──────────┐
   │ transition svc   │              │  MindsPort         │
   │ ONLY writer of   │              │  (server-only)     │
   │ campaign.status  │              └─────────┬──────────┘
   └────────┬─────────┘                        │
            │                        ┌─────────▼──────────────────┐
   ┌────────▼─────────┐              │ MindsClientAdapter (real)  │
   │  Postgres 17     │              │  → api.build.hellominds.ai │
   │  Prisma 7 + pg   │              ├────────────────────────────┤
   │  15 models       │              │ FixtureMindsPort (offline) │
   │  audit trail     │              │  → canned, loudly labelled │
   └────────┬─────────┘              └────────────────────────────┘
            │ nextActionAt due
   ┌────────▼──────────────────────────────┐
   │ follow-up worker — SEPARATE PROCESS   │
   │ FOR UPDATE SKIP LOCKED + lease        │
   │ npm run worker                        │
   └────────┬──────────────────────────────┘
            │
   ┌────────▼──────────────────────────────┐
   │ EmailTransport (interface)            │
   │  → MailpitTransport  [LOCAL TEST]     │
   │  → ConsoleTransport  [LOCAL TEST]     │
   └───────────────────────────────────────┘
```

The worker being a **separate process** is load-bearing, not incidental. Autonomy triggered
inside a request handler would be indistinguishable from a button press. You can close the
browser and the follow-up still fires.

---

## 3. Key design decisions

### 3.1 One writer for `campaign.status`

`src/lib/campaign/transition.ts` is the only module that writes the column. It validates
against an explicit adjacency map, is idempotent (re-entering the current state is a recorded
no-op, not an error), supports optimistic concurrency via `expectedFrom`, and writes the audit
row **inside the same transaction** as the status change. There is no code path that advances a
campaign without leaving a record.

### 3.2 Five timestamps, not one status date

`AgentAction` carries `proposedAt`, `approvedAt`, `attemptedAt`, `executedAt`, `failedAt` as
separate nullable columns. A single mutable "status_at" would overwrite history: after a
failure you could no longer prove the action had been attempted, or when.

The consequence the demo depends on: **a failed external call keeps `attemptedAt` set and
`executedAt` NULL forever.** `toTimelineEvents()` emits one timeline entry per non-null
timestamp, so "attempted" and "succeeded" are independently visible and a failure can never
render as a success.

Human approvals use a *separate* lifecycle (`logApproval`) that writes `proposedAt` plus
`approvedAt`/`failedAt` and never touches the execution timestamps — an approval is a
decision, not an execution. Mixing the two produced an audit summary claiming more successes
than attempts; see `docs/known-limitations.md`.

### 3.3 Max-one follow-up, enforced three times

Safety and retryability pull in opposite directions, so the guarantee is layered:

1. **Lease claim** — `SELECT … FOR UPDATE SKIP LOCKED` plus `lockedUntil`. A second worker
   skips the row rather than blocking; a crashed worker's claim expires instead of wedging the
   campaign.
2. **`followUpCount` compare-and-swap** — the hard cap, incremented in the same transaction as
   the `follow_up_sent` transition and conditional on it still being `0`.
3. **Unique `dedupeKey`** — a success marker written in that same transaction. Postgres rejects
   a second one.

Failed attempts are recorded *without* a dedupeKey. That is what keeps a transient failure
retryable (bounded at 3, with backoff) while a successful send closes the door permanently.

Because the cap lives on the counter rather than on graph position, it survives the campaign
re-entering `awaiting_deliverable` for a revision round.

### 3.4 Structured output, never prose parsing

The Mind is asked for JSON. The reply is fence-stripped, `JSON.parse`d, Zod-validated, and then
**semantically** validated — a schema-perfect response naming a partner who was never offered
is a hallucination, and writing it would put a fabricated recommendation in front of the
creator. `validateRankingSemantics` catches unknown ids, dropped candidates, duplicate ranks,
and non-contiguous ordering.

On failure: record it, retry **once** with the specific issues restated, and if that fails
throw a non-retryable error. There is no best-effort path that invents a result.

### 3.5 Injectable clock

Every deadline, lease expiry, and `nextActionAt` comparison reads `getClock().now()`.
Production code never calls `Date.now()` for a scheduling decision. Tests inject `FixedClock`
and advance it, which is how the three-minute deadline is proven in milliseconds.

### 3.6 Brand safety enforced twice

The Mind is asked to reject a conflicting partner, **and** CollabOS overrides the verdict if it
does not. The override is written to the audit log as `safety.override` rather than applied
silently — "the Mind recommended a partner it should have rejected" is information worth
keeping. Approval of a blocked partner is refused server-side; the UI control is replaced, not
merely disabled.

### 3.7 Resumable pumps over linear scripts

`advanceAfterAcceptance` walks Circle → brief → deliverable with each block guarded by current
state. Three external systems participate, so any step can fail midway. Idempotent and
re-runnable means a failed Circle mutation leaves the campaign honestly stuck at
`circle_add_pending` and the creator can retry without unwinding anything.

---

## 4. Module map

```text
src/env.ts                      Zod-validated env; rejects non-PostgreSQL URLs
src/lib/db.ts                   Prisma singleton, lazily constructed via Proxy
src/lib/clock.ts                Clock interface + FixedClock
src/lib/minds/client.ts         MindsPort + MindsClientAdapter (retries, timeouts, correlation IDs)
src/lib/minds/fixture-port.ts   OFFLINE fixture Mind — E2E only, loudly labelled
src/lib/minds/errors.ts         Typed errors + credential redaction
src/lib/minds/schemas.ts        Zod schemas + semantic validation
src/lib/minds/prompts.ts        Prompt construction from Postgres records
src/lib/minds/reasoning.ts      ask → validate → repair once → typed failure
src/lib/campaign/states.ts      States + legal transition map (pure)
src/lib/campaign/transition.ts  The only writer of campaign.status
src/lib/campaign/service.ts     Objective → ranking → partner approval
src/lib/campaign/collaboration.ts  Outreach → acceptance → Circle → brief
src/lib/campaign/completion.ts  Final approval → completion → relationship write-back
src/lib/campaign/queries.ts     Read models for the UI
src/lib/circle/service.ts       Verify-then-mutate Circle logic
src/lib/audit/log.ts            AgentAction lifecycle + timeline projection
src/lib/email/transport.ts      Transport interface + Mailpit/console
src/lib/links/sign.ts           HMAC-signed collaborator links
src/lib/safety/brand-safety.ts  Deterministic boundary enforcement (pure)
src/lib/seed/demo-seed.ts       The seeded scenario, shared by CLI/tests/reset
src/worker/follow-up.ts         The autonomous worker
```

---

## 5. Data model notes

15 models. The ones whose *shape* encodes a rule:

- **`AgentAction`** — five lifecycle timestamps plus a unique `dedupeKey`. See §3.2.
- **`CampaignOutcome`** — deliberately splits observed facts, computed values, and
  creator-reported figures into separate columns. Conflating them is how a system starts
  fabricating metrics. `creatorReportedPerformance` is nullable so "unknown" is representable
  rather than silently defaulted to a number.
- **`MindExchange`** — stores the full prompt and reply for every Mind interaction, plus
  `validated` and `fixtureMode`. A canned fixture reply can never later be mistaken for a
  genuine one.
- **`CircleMembership`** — unique on `(campaignId, collaboratorEmail)`, with a `failed` status so
  a failed mutation is representable.
- **`Campaign.lockedBy` / `lockedUntil`** — the worker lease.

---

## 6. Trust boundaries

| Boundary | Control |
| --- | --- |
| Browser → server | Server Actions with Zod-validated input. No action writes state directly. |
| Unauthenticated collaborator | HMAC-signed token carrying only a campaign id. No email accepted from the request; the Circle address comes from server config. |
| Server → Minds | API key server-side only, never `NEXT_PUBLIC_`. Browser import of the client throws. |
| Errors → logs/UI/DB | Everything passes through `sanitiseErrorMessage` (JWT, header, and long-token redaction). |
| Collaborator ← creator data | The collaborator page renders no prohibited topics, fit scores, rival candidates, or reliability scores. |

See `docs/security-and-approvals.md` for the approval matrix.
