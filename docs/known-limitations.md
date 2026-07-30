# Known Limitations

Honest record of what does not work, what is not built, and what was discovered about
the platform. Kept current as the build progresses — CLAUDE.md §24 requires reporting
platform limitations rather than overclaiming.

**Last updated:** 2026-07-30 (end of Milestone 2)

---

## 1. Blocking: no Minds credentials on this machine

**Impact: high.** Five Milestone 1 checks cannot be completed.

No `MINDS_BUILDER_API_KEY` exists in the environment, in `~/.minds`, or in
`~/.config/minds`. Verified without printing any value.

| Milestone 1 step | Status |
| --- | --- |
| Validate Node 22+ | Pass — `v22.13.1` |
| Validate CLI version | Pass — `0.1.3` (latest) |
| `minds doctor` | Ran — `api_build_ping` **pass**, `builder_api_key` **absent** |
| Live API reachability | **Proven** — public Bazaar returned `totalCount: 3506` |
| List Minds | **Blocked** |
| Validate configured Mind ID | **Blocked** |
| Cognition balance | **Blocked** |
| Read Circle state | **Blocked** |
| Send safe test message | **Blocked** |

The platform is reachable and the CLI works; only authentication is missing.

**Mitigation, not a workaround.** The integration is fully implemented against the
official client library. `npm run minds:smoke` performs every blocked step and
regenerates `docs/minds-smoke-test.md` from real results, so Milestone 1 completes with
one command once a key is supplied. The setup checklist is in that file.

**What CollabOS does NOT do about it:** it does not fabricate a recommendation, invent a
follow-up, simulate a Circle result, or fall back to a hidden mock. Mind-dependent work
records a `failed` `AgentAction` with error code `MINDS_NOT_CONFIGURED`, and the UI
states plainly that the Mind is not connected.

---

## 2. All seven milestones are complete

Gates at last run: `lint` ✅ · `typecheck` ✅ · `test` ✅ (214) · `build` ✅ · `test:e2e` ✅ (2).

### The offline fixture Mind — read this before demoing

`COLLABOS_UNSAFE_FIXTURE_MIND=1` replaces the Mind with canned responses so the Playwright
end-to-end test can run without credentials. Guards: throws under `NODE_ENV=production`, forces a
permanent red banner onto every page, marks every stored exchange `fixtureMode: true`, badges those
rows in the Activity Log, warns on the server console, and reports a cognition balance of `0`
rather than a plausible number.

**It must never be used for a demo, a screenshot presented as real, or as evidence that the Minds
integration works.** It exists so one automated test can cover the full UI flow. The real
integration remains unverified end-to-end until a Builder API key exists.

### Bugs found during Milestone 7, all invisible to the static gates

| Bug | Found by |
| --- | --- |
| `IDLE` exported from a `"use server"` file — every page with a form failed to render | Playwright E2E |
| Pages had **no `<h1>`** at all — an accessibility defect, since the brand was a bare `<Link>` | Playwright E2E |
| The fixture Mind ranked candidates by prompt order, which is alphabetical — so it recommended Alex over Mira | Playwright E2E |
| `package.json` referenced `scripts/demo-reset.ts`, which did not exist | reading the manifest |

The first two were real product defects, not test artifacts.

### What Milestone 6 has and has not proven

**Proven end-to-end against live infrastructure:** the complete §25 slice was run — objective
→ ranking → partner approval → outreach approval → real Mailpit email → acceptance → Circle →
brief → deliverable → autonomous worker follow-up → submission → final approval → completed →
relationship memory updated. Mira went from 1 collaboration at reliability `0.95` to 2 at
`0.75`, and the report rendered with coherent audit counts.

That reliability *drop* is worth noting as evidence the loop is honest rather than
flattering: in that run the deliverable genuinely arrived after its deadline and genuinely
needed the automated reminder, so the computed score fell.

**Explicitly NOT measured:** audience growth. CollabOS has no analytics integration, so the
only performance figure that can exist is one the creator typed in themselves. It is nullable
and stays null when unreported — never estimated, never defaulted, and the report says so
outright in a dedicated "What this report does not claim" section.

**Not proven:** a real Mind debrief, for the same missing-credential reason as the other
Mind-dependent steps.

### Audit-lifecycle bug found and fixed in Milestone 6

The report initially showed `Attempted: 30, Succeeded: 32` — more successes than attempts,
which is incoherent. Cause: human approvals were being recorded through the *execution*
lifecycle (`markSucceeded` sets `executedAt`) while `attemptedAt` was never set, because an
approval is never "attempted".

Fixed at the source with a dedicated `logApproval()` that writes `proposedAt` plus
`approvedAt`/`failedAt` and never touches the execution timestamps. All four approval sites
(partner selection, partner rejection, first outreach, final deliverable) now use it, and
three regression tests assert the invariant — including a direct query for any row with
`executedAt` set and `attemptedAt` null.

### What Milestone 5 has and has not proven

**Proven with the real worker process:** `npm run worker` was run against a campaign whose
deliverable went overdue. Two seconds after the deadline it claimed the campaign on its own —
no button, no HTTP request, browser closed — recorded
`campaign.follow_up_due` → `campaign.follow_up_generating` → `followup.send`, and then failed
honestly with `MINDS_NOT_CONFIGURED`. The resulting rows show `attemptedAt` set,
`executedAt` NULL, `failedAt` set, `followUpCount` still `0`, the lease released, a retry
scheduled with backoff, **zero** follow-up messages created, and Mailpit still holding only
the single outreach email. That is the §3 "verifiable execution" requirement demonstrated
against live infrastructure rather than asserted.

**Proven deterministically by tests** (clock injected, no real waiting): the successful send
path, exactly-one-follow-up under repeated passes and under two concurrent workers, the
compare-and-swap standing down even when the lease is bypassed, opted-out and
creator-rejected partners being suppressed, an already-submitted deliverable being skipped,
transient-failure recovery, and the bounded-retry cutoff.

**Not proven:** a follow-up whose wording came from a real Mind. Without a Builder API key
the Mind call fails, which is the correct behaviour but means the contextual-wording claim
rests on the prompt content and the scripted tests, not on observed model output.

### What Milestone 4 has and has not proven

**Proven with a real local integration:** the outreach email is genuinely composed, handed
to SMTP, and captured by Mailpit — verified by reading it back out of the Mailpit API,
including the signed acceptance link. The collaborator page renders from that link and
exposes none of the creator's private data (no prohibited topics, fit scores, rival
candidate names, or reliability scores). Circle add is idempotent, and a failed Circle
mutation leaves the campaign at `circle_add_pending` with the membership stored as `failed`
— never `circle_added`, and with no brief or deliverable created behind it.

**Not proven:** a *real* Circle mutation against the Minds platform. The end-to-end
verification used a scripted port for the Circle call because no Builder API key exists, so
`addCircleMembers` has never been exercised against `api.build.hellominds.ai` in this
repository. The client-library call itself is written against the verified 0.1.3 type
contract with read-back confirmation, but the round trip is untested.

Related UI honesty note: when the platform Circle cannot be read, the Room marks the stored
membership row as "Unverified right now" rather than presenting the last known status as
current fact.

### What Milestone 3 has and has not proven

**Proven** (130 tests, integration suite against real Postgres): the objective → ranking →
approval pipeline, structured-output validation with exactly one repair retry, the
brand-safety override, both human-control gates, and the failure paths.

**Not proven:** that a *real* Mind ranks Mira above Alex and Nova. The integration tests
script the Mind's reply, which makes CollabOS's handling deterministic but says nothing
about model judgement. That claim can only be verified with a Builder API key, by running
the flow in the UI and reading the recorded prompt and reply on the Activity Log page.

The prompt does supply everything needed for the Mind to get it right — the prohibited
topics, the relationship history, the previous decline reason, and an explicit instruction
that relevance outweighs follower count — and CollabOS enforces the brand-safety boundary
regardless of the answer. But "the Mind reasons well" is currently an untested claim.

---

## 3. Platform findings

### `beta` dist-tag is older than `latest`

`CLAUDE.md` §8 instructs preferring `@beta` if the dist-tag exists. It exists, but:

```json
{ "beta": "0.1.1", "latest": "0.1.3" }
```

Installing `@beta` would have **downgraded** the CLI. The stated motivation was to get
cognition, Bazaar, Circle, and enable/disable functionality — all four are present in
`0.1.3`. **Installed `@latest`.** Documented deviation.

### Remembered CLI flags were wrong; `--help` is authoritative

Two flag guesses failed against the installed CLI and were corrected from help output:

- `minds bazaar apps --search …` → `--search` is not valid at that level; it belongs to
  `minds bazaar apps list`
- `--page-size` does not exist; the correct flag is `--max` (1–200)

Concrete demonstration of why §8 says to treat `--help` as the source of truth.

### Circle GET and mutation responses have different shapes

`GET /v1/circles/{mindId}` returns `CircleMember[]` **directly**, while `POST`/`DELETE`
return `{ items, summary }`. Conflating them would break Circle state rendering.
`summary.alreadyInCircle` is the idempotency signal CollabOS relies on.

### Circles are human-only

Official client-library docs: "Circles accept human collaborator emails only, not Mind
`@hellominds.ai` addresses." CollabOS rejects `@hellominds.ai` addresses before any
network call. Note the Circle *guide* page describes Minds being addable by email with
automatic role detection — the two docs disagree, so CollabOS follows the stricter,
builder-facing guidance.

### Reply detection requires a fingerprint baseline

`getLatestHistoryFingerprint()` must be called **before** `sendMessage()`, and the
result passed as `waitForReply({ afterFingerprint })`. Without the baseline a reply from
a previous turn can be misread as the answer to the current question. Not obvious from
the method signatures alone.

---

## 4. Stack constraints discovered

### Prisma 7 mandates a driver adapter

`new PrismaClient()` without an adapter is a **type error** in Prisma 7 —
`PrismaClientOptions` is a union requiring either `adapter` or an Accelerate URL. The
implicit query engine of earlier majors is gone. CollabOS uses
`@prisma/adapter-pg`. Other Prisma 7 changes that break Prisma 6 muscle memory:

- generator is `provider = "prisma-client"` (not `prisma-client-js`) and needs an
  explicit `output`
- the `datasource` block carries **no** `url`; it moved to `prisma.config.ts`
- generated output is TypeScript source importing siblings with `.ts` specifiers, so
  `allowImportingTsExtensions` is required

### Next.js 16 removed the `eslint` config key

`next.config.ts` cannot carry an `eslint` block. Linting is a standalone gate.

### TypeScript pinned to 5.9, not 7.0.2

`7.0.2` is the native/Go compiler rewrite; `typescript-eslint@8` does not declare
support for it, and a broken `lint`/`typecheck` fails a mandatory quality gate.

### ESLint pinned to 9

`@eslint/js@10` hard-requires `eslint@^10`; mixing majors produces `ERESOLVE`.
(`typescript-eslint@8.65` itself accepts eslint 10 — this is a consistency choice.)

---

## 5. Environment issues on this machine

### Port 3000 is occupied by an unrelated service

`node dist/api/server.js` (PID 222544 at time of writing) holds port 3000, so
`next dev` falls back to **3001**. Because `.env` ships `APP_URL=http://localhost:3000`,
signed collaborator acceptance links would point at the **wrong server**. Set
`APP_URL=http://localhost:3001` or free the port before demoing Milestone 4.

### `CLAUDE.md` is excluded by the machine's global gitignore

`~/.config/git/ignore:6` lists `CLAUDE.md`, so a spec-required deliverable would never
be committed. Resolved *within this repository only* by a `!CLAUDE.md` negation in
`.gitignore` — repository-level patterns take precedence over `core.excludesFile`. The
user's global config was **not** modified.

### `npm audit` reports 8 high-severity advisories

All transitive, all in latest published versions, none introduced by pinning here:

| Package | Advisory |
| --- | --- |
| `brace-expansion` (via `eslint`, `minimatch`) | DoS via unbounded expansion |
| `postcss` (via `next`) | XSS via unescaped `</style>`; arbitrary file read |
| `sharp` (via `next`) | libvips CVE-2026-33327 / 33328 / 35590 |

`npm audit fix` offers no non-breaking resolution; `--force` would downgrade Next.js.
Accepted for a local hackathon build with no untrusted input; would need revisiting
before any public deployment.

---

## 6. Deliberate scope exclusions

Excluded by `CLAUDE.md` §19, not oversights: blockchain, tokens, NFTs, escrow, MENTE
transfers, multi-chain, public creator marketplace, multi-agent architecture, social
scraping, multi-platform auto-publishing, complex analytics, billing, production
identity verification. A verifiable collaboration receipt stays roadmap-only.

Additional MVP simplifications:

- **No authentication.** One seeded creator; every browser session is "Maya". Any
  multi-tenant deployment would need real auth before the approval gates meant anything.
- **Synthetic partners only.** All three candidates are seeded records on the reserved
  `@example.com` domain. No real creator is contacted, and audience figures are
  illustrative — CollabOS never presents them as measured platform data.
- **No real audience-growth measurement.** `performanceScore` is seeded and
  creator-reported, not fetched from any platform. Genuine attribution would need
  analytics integrations that are explicitly out of scope.
- **Single-region, single-worker assumption.** Worker claiming uses
  `FOR UPDATE SKIP LOCKED` with a lease, which is correct for concurrent workers against
  one Postgres, but there is no distributed scheduler.
