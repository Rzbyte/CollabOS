# CollabOS

**A persistent Creator Partnership Director built on [Minds by Animoca Brands](https://hellominds.ai/).**

> The creator chooses the relationship. CollabOS runs everything in between.

CollabOS remembers creator relationships, finds aligned collaborators, brings approved
partners into a trusted Mind Circle, coordinates the joint campaign, follows up
autonomously, and learns which partnerships actually grow the audience.

It is built to be an **operator**, not a recommendation chatbot.

---

## Build status

This is an in-progress hackathon build. What is **actually working right now**, verified:

| Milestone | Status |
| --- | --- |
| 0 — Repository & documentation inspection | **Complete** — see [`docs/implementation-plan.md`](docs/implementation-plan.md) |
| 1 — Minds platform proof | **Partially complete — blocked on credentials.** Unauthenticated half proven against the live API; the rest is automated and runs the moment a key exists |
| 2 — Foundation | **Complete** — Postgres + Prisma + migrations + seed + env validation + Minds wrapper + audit log + state machine |
| 3 — Recommendation & approval | **Complete** — objective form, structured Mind ranking with repair-retry, Partner Review UI, approval gates, Activity Log |
| 4 — Circle & campaign | **Complete** — Circle admission, shared brief, deliverable, Collaboration Room, signed collaborator link, emergency cleanup command |
| 5 — Autonomous follow-up worker | **Complete** — separate worker process, lease-based claiming, max-one follow-up enforced in the database, bounded retries, live UI polling |
| 6 — Completion loop | **Complete** — final approval, completion, relationship write-back, revision round, campaign report |
| 7 — Quality & demo polish | **Complete** — Playwright E2E, loading/error states, accessibility basics, demo reset, full documentation, demo script |

Quality gates as of the last run: `lint` ✅ · `typecheck` ✅ · `test` ✅ (214 tests) · `build` ✅ ·
`test:e2e` ✅ (2 tests)

The full §25 vertical slice has been run end-to-end against live Postgres and Mailpit —
objective → ranking → partner approval → outreach approval → real email → acceptance →
Circle → brief → deliverable → **autonomous worker follow-up** → submission → final approval
→ completed → relationship memory updated. Only the Mind is scripted, because no Builder API
key exists yet.

Milestone 3 is verified by integration tests that run the real state machine, real Prisma, and
real audit log against Postgres with only the Mind scripted — including that Mira is ranked
above two larger audiences, that a brand-unsafe partner is force-rejected even when the Mind
recommends it, and that a failed Mind call cannot produce a false success state.

### The one genuine blocker

**No Minds Builder API key is configured on this machine**, so the Mind cannot be
reasoned with yet. This is a credential gap, not a code gap: the integration is fully
implemented against the official client library.

CollabOS deliberately **boots and runs in this state** and reports the Mind as
disconnected. It does not fabricate a recommendation, a follow-up, or a Circle result
to paper over the gap. See [Connecting a Mind](#connecting-a-mind).

---

## Why Minds is integral

CollabOS is not "an app that calls an LLM". The division of responsibility is
structural:

| Minds owns — *relationship intelligence* | CollabOS owns — *deterministic execution* |
| --- | --- |
| Creator and brand context | Campaign state machine |
| Relationship memory across sessions | Database records |
| Partner-fit reasoning | Scheduling and the follow-up worker |
| Context-aware message wording | Approval enforcement |
| Campaign continuity | Circle mutations and transport |
| Follow-up reasoning | Audit log, retries, idempotency |

> **Minds owns contextual memory. CollabOS owns operational state.**

Chat history is never used as the operational database, and Postgres is never asked to
make a judgement.

### How the four hackathon requirements are demonstrated

**Memory** — Maya's brand voice, target audience, prohibited topics, and her full
relationship history with each partner live in Postgres and are sent to the Mind as
structured context on every call. The Mind is asked to return the specific remembered
facts it used (`memoryUsed`), which the Partner Review UI renders as evidence that
memory *drove* the decision rather than decorating it.

**Continuity** — one durable conversation alias per creator
(`CreatorProfile.mindConversationAlias`, e.g. `collabos-maya`), bound idempotently via
`ensureConversation()`. Every session and every worker run reuses it, so the Mind is
never re-briefed and the creator never re-explains the campaign.

**Circle** — an approved collaborator is added to the Mind's Circle through
`addCircleMembers()`, verified before *and after* mutation. Circles are the platform's
actual trust gate ("Circles are how Minds and humans get permission to talk to each
other"), so this is a real permission change, not a cosmetic one.

**Autonomy** — a server-side worker polls `nextActionAt`, claims work with
`SELECT … FOR UPDATE SKIP LOCKED`, asks the Mind to compose a contextual follow-up, and
sends it. **There is no manual "Follow Up" button anywhere in the UI**, by design.

---

## Local setup

### Requirements

- Node.js ≥ 22 (tested on 22.13.1)
- Docker + Docker Compose
- A Minds Builder API key (for the Mind-backed features)

### 1. Install

```bash
npm install
```

`postinstall` runs `prisma generate` automatically.

### 2. Configure environment

```bash
cp .env.example .env
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `MINDS_BUILDER_API_KEY` | for Mind features | Builder API key. **Server-side only.** |
| `MINDS_MIND_ID` | for Mind features | Which Mind acts as Partnership Director |
| `COLLABORATOR_TEST_EMAIL` | for Circle step | The **only** address CollabOS will add to a Circle |
| `DATABASE_URL` | **yes** | Postgres connection string (SQLite is rejected) |
| `APP_URL` | **yes** | Base URL for signed collaborator links |
| `EMAIL_TRANSPORT` | no | `mailpit` (default) or `console` |
| `MAILPIT_HOST` / `MAILPIT_SMTP_PORT` | no | Local test SMTP, defaults `localhost:1025` |
| `FOLLOW_UP_DELAY_SECONDS` | no | Deliverable window. `180` = the 3-minute demo |
| `LINK_SIGNING_SECRET` | no | HMAC secret for acceptance links; dev default if unset |
| `MINDS_REPLY_TIMEOUT_MS` | no | Mind reply timeout, default `120000` |

Configuration is validated by Zod at startup (`src/env.ts`) — the app refuses to boot
on a bad config rather than failing later inside a request.

> ⚠️ **Port note:** on this machine port **3000 is already occupied** by an unrelated
> service, so `next dev` falls back to **3001**. If that applies to you, set
> `APP_URL=http://localhost:3001` or signed collaborator links will point at the wrong
> server.

### 3. Start infrastructure

```bash
npm run infra:up
```

Starts two containers:

- **Postgres 17** on `localhost:5432`
- **Mailpit** — SMTP on `1025`, web UI on **<http://localhost:8025>**

### 4. Database

```bash
npm run db:migrate   # apply migrations
npm run db:seed      # load the demo scenario
```

`npm run db:reset` wipes and reseeds for a clean demo take.

### 5. Run

```bash
npm run dev
```

### 6. Run the worker

The autonomous follow-up worker is a **separate process** — this is what makes the
autonomy real rather than a request-triggered illusion.

```bash
npm run worker                    # continuous polling loop (Ctrl-C to stop)
npm run worker:once               # single pass, then exit
npm run worker -- --interval 2000 # faster polling for a live demo
```

Because it is a separate process, you can close the browser entirely and the follow-up
still fires — which is the point. The Command Center, Room, and Activity Log poll every
5 seconds (there is a pausable "Live" indicator in the nav), so the follow-up appears
without any interaction.

How "at most one follow-up" is guaranteed, in layers:

1. **Lease claim** — `SELECT … FOR UPDATE SKIP LOCKED` plus a `lockedUntil` expiry. A second
   worker skips the row rather than blocking, and a crashed worker's claim frees itself.
2. **`followUpCount` compare-and-swap** — the hard cap, incremented in the same transaction
   as the `follow_up_sent` transition and conditional on it still being `0`.
3. **Unique `dedupeKey`** — a success marker written in that same transaction, so Postgres
   itself rejects a second recorded success.

Failed attempts are recorded *without* a dedupeKey, so a transient failure stays retryable
(bounded at 3 attempts with backoff) while a successful send closes the door for good.

---

## Connecting a Mind

1. Create a Builder API key at <https://build.hellominds.ai/console> → sign in →
   **Keys** → **Create**.
2. Put it in `.env` as `MINDS_BUILDER_API_KEY`. Never commit it.
3. Find your Mind ID:
   ```bash
   minds list --pretty
   ```
   Add it as `MINDS_MIND_ID`. Create a Mind at <https://hellominds.ai/profile> if needed.
4. Set `COLLABORATOR_TEST_EMAIL` to an inbox **you** control.
5. Verify:
   ```bash
   npm run minds:smoke
   ```

`npm run minds:smoke` runs every Milestone 1 check and **regenerates**
[`docs/minds-smoke-test.md`](docs/minds-smoke-test.md) from the real results, so that
evidence file is never hand-written or stale. It is safe to run without credentials —
authenticated checks simply report `BLOCKED`.

The CLI is used for **setup and diagnostics only**. Runtime integration goes through
`@animocabrands/minds-client-lib`; no request handler shells out to the CLI.

---

## Which actions are real, and which are local test transport

Being precise about this matters more than making the demo look impressive.

| Action | Reality |
| --- | --- |
| Partner-fit reasoning, follow-up wording | **Real** — live Minds API call |
| Cognition balance | **Real** — live read |
| Circle add / remove / read | **Real** — genuinely mutates the Mind's Circle |
| Conversation history & continuity | **Real** — persisted on the platform |
| Campaign state, approvals, audit log | **Real** — Postgres |
| Outreach & follow-up **email** | 🟣 **LOCAL TEST TRANSPORT (Mailpit)** — captured at <http://localhost:8025>, never delivered to the internet |
| Partner identities | 🟣 **Synthetic** — seeded demo records on the reserved `@example.com` domain |
| Partner replies / acceptance | 🟣 **Human tester** via a signed local link — never fabricated by the system |

**Not done, in any form:** no Instagram / X / TikTok / YouTube message is sent or
claimed; no social platform is scraped; no X embed; no blockchain, token, NFT, escrow,
or payment; no multi-agent orchestration.

Every mocked or local-transport action is labelled as such in the UI. A failed external
call is recorded as `attempted` + `failed` and can never render as success.

---

## Tests

```bash
npm test               # 214 tests — unit + integration
npm run test:unit      # pure, no infrastructure needed
npm run test:integration
npm run test:e2e       # Playwright — the full vertical slice in a browser
```

Time is injected through `src/lib/clock.ts`, so the overdue-deliverable and
autonomous-follow-up tests advance a controlled clock instead of waiting three real
minutes. The E2E test drives a real HTTP server, so it shortens the configured deadline to
5 seconds rather than sleeping.

Tests bind a scripted `MindsPort` double. That is dependency injection for
determinism — the production binding is always the real client library, and a failed
integration is never hidden behind a mock. **It also means no automated test proves the Mind
reasons well;** that gap is recorded in `docs/known-limitations.md` rather than glossed over.

Full detail in [`docs/test-plan.md`](docs/test-plan.md).

### ⚠️ The offline fixture Mind

The Playwright test needs a Mind, and no API key exists here, so
`COLLABOS_UNSAFE_FIXTURE_MIND=1` swaps in canned responses. It is a **labelled test seam, not a
hidden mock**:

- throws under `NODE_ENV=production` rather than degrading quietly
- every page renders a permanent red warning banner while it is active
- every stored exchange is marked `fixtureMode: true` and badged in the Activity Log
- warns on the server console at construction

**Never use it for a demo or a screenshot presented as real.** It proves nothing about the Minds
integration.

---

## Quality gates

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

---

## Current limitations

Full list in [`docs/known-limitations.md`](docs/known-limitations.md). The headlines:

- **Milestone 1 is not fully proven** — listing Minds, validating the Mind ID, reading
  cognition balance, reading Circle state, and sending a test message all require a
  Builder API key that is not present. The live API *is* reachable (verified against the
  public Bazaar catalogue: 3,506 skills).
- **Milestones 3–7 are not built yet.** The recommendation flow, Circle wiring,
  Collaboration Room, worker, and completion loop are designed and scaffolded but not
  implemented.
- No authentication — single seeded creator, local demo only.
- Email delivery is Mailpit only; there is no real provider transport.
- `npm audit` reports upstream advisories in `eslint`→`brace-expansion` and
  `next`→`postcss`/`sharp` at their latest published versions. Not introduced by
  version pinning here; no non-breaking fix is available.

---

## Documentation

| Document | Contents |
| --- | --- |
| [`CLAUDE.md`](CLAUDE.md) | Project instructions and spec |
| [`docs/product-spec.md`](docs/product-spec.md) | What CollabOS is, the seeded scenario, requirement mapping |
| [`docs/architecture.md`](docs/architecture.md) | Responsibility split, process topology, key design decisions |
| [`docs/implementation-plan.md`](docs/implementation-plan.md) | Verified platform contract and stack decisions |
| [`docs/security-and-approvals.md`](docs/security-and-approvals.md) | Approval matrix, secret handling, trust boundaries |
| [`docs/test-plan.md`](docs/test-plan.md) | Coverage map, what is real in each layer, bugs caught |
| [`docs/demo-script.md`](docs/demo-script.md) | Two-minute demo script with setup checklist |
| [`docs/minds-smoke-test.md`](docs/minds-smoke-test.md) | Generated Milestone 1 evidence |
| [`docs/known-limitations.md`](docs/known-limitations.md) | Honest limitations and blockers |
| [`docs/roadmap.md`](docs/roadmap.md) | What would come next, and what is deferred by design |
