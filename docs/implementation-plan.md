# CollabOS — Implementation Plan

> Milestone 0 deliverable. Written after inspecting the repository, the installed
> `@animocabrands/minds-cli` / `@animocabrands/minds-client-lib` contracts, and the official
> Builder documentation. Updated as platform facts are discovered.

**Status date:** 2026-07-29

---

## 1. Repository status at start

The repository was **effectively empty**: a `.git` directory on branch `main` with **zero commits**
and no tracked files.

Present on disk at plan time:

| Path | Origin |
| --- | --- |
| `CLAUDE.md` | Supplied by the user (project instructions, 1135 lines) |
| `package.json` | Created during this session |
| `docker-compose.yml` | Created during this session |

There was no pre-existing code, so there are **no existing conventions to preserve**. Everything is
greenfield and follows this plan.

### Version-control finding (needs a human decision)

`CLAUDE.md` is a required deliverable (`CLAUDE.md` §21) but it is excluded by the machine's **global**
gitignore:

```text
/home/aris/.config/git/ignore:6:CLAUDE.md
```

It therefore exists on disk but will never be committed by a normal `git add .`. This session does
**not** modify the user's global git config and does **not** `git add -f` the file. Options for the
owner: commit with `git add -f CLAUDE.md`, add a negation (`!CLAUDE.md`) to the repository's
`.gitignore`, or accept it as local-only.

---

## 2. Detected environment

| Component | Detected | Requirement | Verdict |
| --- | --- | --- | --- |
| Node.js | `v22.13.1` | ≥ 22 | Pass |
| npm | `10.9.2` | — | Pass |
| Docker | `29.6.1` | for Postgres + Mailpit | Pass |
| Docker Compose | `v5.3.1` | — | Pass |
| `minds` CLI | `0.1.3` | latest | Pass |
| `@animocabrands/minds-client-lib` | `0.1.3` | — | Pass |
| Local `psql` binary | not installed | — | Not needed; Postgres runs in Docker |

### CLI dist-tag finding — deviation from the literal instruction

`CLAUDE.md` §8 says to prefer `@beta` if the `beta` dist-tag exists. It does exist, but it is **older
than `latest`**:

```json
{ "beta": "0.1.1", "latest": "0.1.3" }
```

Installing `@beta` would have **downgraded** the CLI. The stated purpose of preferring beta was to
obtain cognition, Bazaar, Circle, and enable/disable functionality — and `0.1.3` was verified to
contain all four (`minds cognition`, `minds bazaar`, `minds circle`, `minds mind`). Decision:
**install `@latest` (0.1.3)**. Recorded here and in `docs/minds-smoke-test.md`.

---

## 3. Platform contract (verified, not assumed)

Verified by reading `dist/index.d.ts` of the installed client library, every relevant `--help`
output, and the official Builder docs. **Conclusion: no custom HTTP adapter is required** — the
official client library covers 100% of the capabilities `CLAUDE.md` §10 asks for.

| §10 requirement | Client-library method | Verified |
| --- | --- | --- |
| Validate configured Mind | `listMinds()`, `getMind(mindId)` | Yes |
| Send messages | `sendMessage({ alias, messageText })` | Yes |
| Wait for replies | `waitForReply({ alias, timeoutMs, afterFingerprint })` | Yes |
| Read conversation history | `getHistory(alias, { limit, after })` | Yes |
| Cognition balance | `getCognitionBalance(mindId)` → `{ mindId, cognition }` | Yes |
| Read Circle membership | `getCircle(mindId)` → `CircleMember[]` | Yes |
| Add human collaborator | `addCircleMembers(mindId, { emails, isActive })` | Yes |
| Remove human collaborator | `removeCircleMembers(mindId, { emails })` | Yes |
| Typed errors | `MindsApiError { status, code, message, requestId }` | Yes |
| Timeouts | `AbortSignal` accepted on read paths | Yes |
| Bounded retries | Not provided — **CollabOS implements this** | Ours |
| Correlation IDs | Not provided — **CollabOS implements this** | Ours |

### Platform facts that shape the design

1. **Base URL is fixed** at `https://api.build.hellominds.ai`; auth header is `X-Api-Key`. Builders
   cannot configure a base URL.
2. **A Builder API key is a JWT** carrying a `humanId` claim; `listMinds()` defaults its `humanId`
   from that claim (`parseHumanIdFromBuilderApiKey`).
3. **Aliases are account-level stable handles.** `ensureConversation(alias, mindId)` is idempotent
   and handles HTTP 409. This is the mechanism CollabOS uses for **continuity**: one durable alias
   per creator, reused across every session and every worker run.
4. **Reply detection needs a fingerprint baseline.** The correct sequence is
   `getLatestHistoryFingerprint(alias)` → `sendMessage(...)` → `waitForReply({ afterFingerprint })`.
   Without the baseline, a stale prior reply can be mistaken for the new one. CollabOS always
   captures the baseline first.
5. **`senderType` disambiguates authorship**: `0` or `2` = Mind, `1` = human.
6. **Circle mutation returns a summary, not just members.** `POST`/`DELETE` return
   `{ items, summary }` where `summary.alreadyInCircle` / `alreadyInCircle`-style counters make
   "already exists" detectable — this is exactly the idempotency signal §16 requires. `GET` returns
   `CircleMember[]` directly (a *different* shape — do not conflate).
7. **Circles are the platform's trust gate.** Official wording: "Circles are how Minds and humans get
   permission to talk to each other." A new Mind hears only its Steward; everyone else is blocked
   until explicitly added, and unknown senders are *silently* dropped. The Steward is permanent and
   cannot be removed.
8. **Circles take human emails.** The client-library docs state plainly: "Circles accept human
   collaborator emails only, not Mind `@hellominds.ai` addresses." Matches §16 — no Mind-to-Mind
   Circle attempts.

---

## 4. Missing credentials (the only genuine blocker)

No Minds credentials exist on this machine. Verified without printing any value: no
`MINDS_*` environment variables, no `~/.minds`, no `~/.config/minds`.

`minds doctor` confirms the split precisely:

```json
{ "name": "api_build_ping",   "ok": true,  "message": "pong (GET /v1/auth/ping)" }
{ "name": "builder_api_key",  "ok": false, "message": "MINDS_BUILDER_API_KEY is not set" }
{ "name": "cli_version",      "ok": true,  "message": "0.1.3 (latest on npm)" }
```

The platform is reachable; only authentication is absent.

**Required from the project owner** (two values, never committed):

| Variable | Where to get it |
| --- | --- |
| `MINDS_BUILDER_API_KEY` | <https://build.hellominds.ai/console> → sign in → Keys → Create |
| `MINDS_MIND_ID` | `minds list --pretty` once the key is set, or <https://hellominds.ai/profile> |
| `COLLABORATOR_TEST_EMAIL` | An inbox the owner controls, used for the Circle add |

### Consequence, and how the plan absorbs it

Per `CLAUDE.md` §24 ("when credentials are missing") this does **not** stop the build. The response is:

- `.env.example` ships with every variable.
- The Minds integration boundary is implemented in full against the real client library.
- Mind-dependent work records a **`failed`** `AgentAction` with a typed
  `MINDS_NOT_CONFIGURED` error code and the UI displays a blunt "Mind not connected" state.
  **No recommendation, follow-up, or Circle result is ever fabricated.**
- `scripts/minds-smoke.ts` (`npm run minds:smoke`) performs *every* remaining Milestone 1 step
  automatically. The instant a key is present, Milestone 1 finishes with one command and rewrites its
  sanitised evidence file.

---

## 5. Architecture

The governing rule from §6: **Minds owns contextual memory. CollabOS owns operational state.**

Concretely — the Mind is never asked to remember an operational fact, and Postgres is never asked to
produce a judgement.

```text
┌─────────────────────── Next.js App Router (RSC) ───────────────────────┐
│  Command Center · Partner Review · Collaboration Room · Activity Log   │
│  Server Actions only — UI never writes campaign.status directly        │
└───────────────┬───────────────────────────────────────┬───────────────┘
                │                                       │
        ┌───────▼────────┐                    ┌─────────▼──────────┐
        │ transition svc │  the ONLY writer   │  MindsPort         │
        │ (state machine)│  of campaign.status│  (server-only)     │
        └───────┬────────┘                    └─────────┬──────────┘
                │                                       │
        ┌───────▼────────┐                    ┌─────────▼──────────┐
        │  Postgres      │                    │ minds-client-lib   │
        │  (Prisma 7)    │                    │ api.build.…ai      │
        │  audit trail   │                    └────────────────────┘
        └───────┬────────┘
                │  nextActionAt due
        ┌───────▼──────────────────────────────┐
        │ follow-up worker (separate process)  │
        │ FOR UPDATE SKIP LOCKED + lease       │
        └──────────────────────────────────────┘
                │
        ┌───────▼──────────────────────────────┐
        │ EmailTransport (interface)           │
        │ → MailpitTransport [LOCAL TEST]      │
        └──────────────────────────────────────┘
```

### Layout

```text
prisma/schema.prisma          models + CampaignStatus enum
prisma/seed.ts                Maya, Mira, Alex, Nova + relationship history
src/env.ts                    Zod-validated, server-only env
src/lib/db.ts                 Prisma singleton
src/lib/clock.ts              injectable Clock (tests never wait 3 real minutes)
src/lib/minds/client.ts       server-only wrapper: timeouts, retries, correlation IDs
src/lib/minds/schemas.ts      Zod schemas for structured Mind output
src/lib/minds/reasoning.ts    ask → validate → one repair retry → typed failure
src/lib/campaign/states.ts    states + legal transition map
src/lib/campaign/transition.ts the dedicated transition service
src/lib/audit/log.ts          AgentAction lifecycle recorder
src/lib/circle/service.ts     verify-then-mutate Circle logic
src/lib/email/transport.ts    interface + Mailpit implementation
src/lib/links/sign.ts         HMAC-signed collaborator acceptance links
src/worker/follow-up.ts       autonomous worker
scripts/worker.ts             npm run worker
scripts/minds-smoke.ts        completes Milestone 1 when credentials exist
scripts/circle-cleanup.ts     emergency Circle removal
```

### Six decisions worth stating

1. **The state machine is the only writer of `campaign.status`.** A single `transition()` function
   validates against an explicit adjacency map, is idempotent (re-entering the current state is a
   recorded no-op, not an error), rejects illegal edges, and writes the audit row inside the same
   transaction as the status change. UI code cannot bypass it.

2. **Proposed / approved / attempted / succeeded / failed are distinct persisted facts.** `AgentAction`
   carries five separate nullable timestamps (`proposedAt`, `approvedAt`, `attemptedAt`,
   `executedAt`, `failedAt`) plus a status. The Activity Log renders **one timeline entry per
   non-null timestamp**, so "attempted" and "succeeded" can never collapse into one another. A failed
   external call leaves `attemptedAt` set and `executedAt` null — permanently visible.

3. **Max-one follow-up is enforced by the database, not by application logic.** `AgentAction` gets a
   unique `dedupeKey` (`followup:v1:<campaignId>`). Two concurrent workers cannot both insert it; the
   loser gets a unique-constraint violation and stands down. Application-level `followUpCount` checks
   are a second layer, not the guarantee.

4. **Worker claiming uses Postgres, not a JS mutex.** `SELECT … FOR UPDATE SKIP LOCKED` plus a
   `lockedUntil` lease means a crashed worker's claim expires instead of wedging the campaign.

5. **Structured output is validated, never prose-parsed.** The Mind is asked for JSON; the reply is
   fence-stripped, `JSON.parse`d, and Zod-validated. On failure: record the failure, retry **once**
   with a repair instruction, and if that fails surface an actionable error. There is no
   "best-effort" path that invents a recommendation.

6. **Tests inject a `MindsPort`, they do not monkey-patch a mock over a failed integration.** The
   production binding is the real client library. Test bindings are scripted fakes, clearly named,
   used only under `tests/`. This is dependency injection for determinism — explicitly *not* the
   "hide a failed integration behind a mock" pattern §24 forbids.

### Honesty guarantees (§14, §18)

- Mailpit is labelled **"Local test transport"** everywhere it appears in the UI, and the Activity Log
  names the transport on every send.
- No social platform is ever named as a delivery channel.
- Circle state renders from the **stored platform response**. A failed mutation shows
  `circle_add_failed`, never `circle_added`.
- Every partner is flagged `isSynthetic: true` in the seed and surfaced as demo data in the UI.

---

## 6. Milestone execution order

| # | Milestone | Blocked by missing key? |
| --- | --- | --- |
| 0 | Inspection, contract verification, this plan | No — complete |
| 1 | Minds platform proof | **Partially** — unauthenticated half proven; rest automated in `minds:smoke` |
| 2 | Foundation: Next.js, Postgres, Prisma, seed, env, wrapper, audit, state machine | No |
| 3 | Recommendation + approval (Mind call fails honestly without a key) | Partially |
| 4 | Circle + brief + Collaboration Room + acceptance | Partially |
| 5 | Autonomous follow-up worker | Partially |
| 6 | Completion loop + relationship memory update | No |
| 7 | Tests, states, docs, demo script, quality gates | No |

"Partially" means the deterministic half (records, transitions, audit rows, UI, tests against an
injected port) is fully built and tested now; only the live network call needs the key.

### Milestone 1 status detail

| Step | Result |
| --- | --- |
| Validate Node 22+ | Pass — `v22.13.1` |
| Validate CLI version | Pass — `0.1.3`, latest |
| `minds doctor` | Ran — `api_build_ping` pass, key absent |
| Live API reachability | **Proven** — public Bazaar returned `totalCount: 3506` |
| List Minds | Blocked — needs key |
| Validate configured Mind ID | Blocked — needs key |
| Cognition balance | Blocked — needs key |
| Read Circle state | Blocked — needs key |
| Send safe test message | Blocked — needs key |
| Record sanitised results | Pass — `docs/minds-smoke-test.md` |

---

## 7. Quality gates

`npm run lint`, `npm run typecheck`, `npm test`, `npm run build` must all pass before any milestone is
called complete, plus Playwright where configured. A failing command is reported as a failure with its
output — never restated as success.

---

## 8. Stack version decisions

Latest stable across the board (`next@16.2.12`, `react@19.2.8`, `prisma@7.9.1`, `zod@4`,
`tailwindcss@4`, `vitest@4`), with two deliberate holdbacks:

- **TypeScript `^5.9`, not `7.0.2`.** 7.0.2 is the native/Go compiler rewrite. `typescript-eslint@8`
  does not declare support for it, and a broken `npm run lint` / `npm run typecheck` would fail a
  mandatory quality gate. The 5.9 line satisfies "TypeScript with strict mode" with no risk.
- **ESLint `^9`, not `10.8.0`.** `typescript-eslint@8.65` *does* accept eslint 10
  (`^8.57.0 || ^9.0.0 || ^10.0.0`), so this is a consistency choice rather than a compatibility one:
  eslint 9 is paired with `@eslint/js@^9`, since `@eslint/js@10` hard-requires eslint 10 and mixing
  the two produces an `ERESOLVE` failure.

Strictness beyond the spec's minimum: `noUncheckedIndexedAccess` and `noFallthroughCasesInSwitch` are
enabled on top of `strict`, because indexed access is pervasive in the ranking and audit code where an
unchecked index would be a genuine correctness bug. Prisma's generated output carries `@ts-nocheck`
and is excluded from both `tsc` and eslint, so generated code creates no friction.

Prisma 7 specifics that differ from Prisma 6 and are easy to get wrong: the generator is
`provider = "prisma-client"` (not `prisma-client-js`) and requires an explicit `output`; the
`datasource` block carries **no** `url`, which now lives in `prisma.config.ts`. Both were confirmed by
running `prisma init` in a scratch directory rather than from memory.
