# Known Limitations

Honest record of what does not work, what is not built, and what was discovered about
the platform. Kept current as the build progresses — CLAUDE.md §24 requires reporting
platform limitations rather than overclaiming.

**Last updated:** 2026-07-30, after end-to-end verification against the live Minds platform.

---

## 1. Live verification status — all 16 Definition-of-Done items proven

Credentials were supplied on 2026-07-30 and the full vertical slice was run against the real
platform with **no fixture or scripted component anywhere** (verified: 7 Mind exchanges
recorded, 0 with `fixtureMode: true`).

Milestone 1: **8/8 PASS.** Mind `CollabOS` on `minimax/minimax-m3`, cognition read live, Circle
read live, test message round-tripped.

The three items that were previously unprovable:

| # | Item | Result |
| --- | --- | --- |
| **2** | Mind recommends Mira over Alex and Nova from seeded context | **Proven.** `#1 Mira [recommended] fit 96` (48k audience) · `#2 Alex [consider] fit 45` (210k) · `#3 Nova [reject] fit 0` (540k). Reproduced across two independent runs. |
| **4** | Controlled collaborator added to the Mind's Circle | **Proven.** New party `578d31f5-…` created and added, confirmed independently via `minds circle show`. |
| **8** | Mind produces contextual follow-up wording | **Proven.** Referenced the specific deliverable, acknowledged the passed deadline, and offered an extension — in Maya's voice and Mira's stated concise style. |

Two findings worth noting because they validate design decisions:

- The Mind **rejected Nova on its own reasoning** — `overrides: none`. The deterministic
  brand-safety override never had to fire, though it remains as the guarantee.
- The relationship write-back **lowered** Mira's reliability, 0.95 → 0.75, because she genuinely
  delivered late and needed the reminder. The learning loop records what happened rather than
  what flatters the partner. The Mind's debrief independently advised weighing "this
  collaboration's reminder-dependent deadline" in future recommendations.

Audit totals for the run: `proposed=32 approved=3 attempted=29 succeeded=29 failed=0` —
succeeded never exceeds attempted, confirming the approval-lifecycle fix holds in production.

### Measured performance (plan accordingly)

| Operation | Latency |
| --- | --- |
| Partner ranking | 86–145 s |
| Outreach wording | 137 s |
| Circle add + brief | 182 s |
| Follow-up wording | 148 s |
| Debrief | 182 s |
| **Full campaign** | **~13 min, ~15.4 cognition** |

This forced a real bug fix: `MINDS_REPLY_TIMEOUT_MS` defaulted to 120 s against a 145 s
ranking call, so a healthy Mind would have timed out and reported "could not produce
recommendations". Raised to 240 s. It also made the original 2-minute demo script
unachievable — see `docs/demo-script.md`, now rewritten around measured timings.

---

## 2. All seven milestones are complete

Gates at last run: `lint` ✅ · `typecheck` ✅ · `test` ✅ (232) · `build` ✅ · `test:e2e` ✅ (2).

### The offline fixture Mind — read this before demoing

`COLLABOS_UNSAFE_FIXTURE_MIND=1` replaces the Mind with canned responses so the Playwright
end-to-end test can run without credentials. Guards: throws under `NODE_ENV=production`, forces a
permanent red banner onto every page, marks every stored exchange `fixtureMode: true`, badges those
rows in the Activity Log, warns on the server console, and reports a cognition balance of `0`
rather than a plausible number.

**It must never be used for a demo, a screenshot presented as real, or as evidence that the Minds
integration works.** It exists so one automated test can cover the full UI flow without
credentials.

The real integration is now verified end-to-end (§1), so the fixture Mind's only remaining
purpose is keeping the E2E test runnable on a machine with no API key. Check the banner is absent
before recording anything.

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

**Since proven (§1):** the Mind debrief ran live and returned usable guidance — it advised
weighing "this collaboration's reminder-dependent deadline" in future partner choices.

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

**Since proven (§1):** the follow-up wording came from the real Mind. It named the specific
deliverable, acknowledged the passed deadline, and offered an extension — matching Maya's calm
brand voice and Mira's stated preference for concise, practical messages.

### What Milestone 4 has and has not proven

**Proven with a real local integration:** the outreach email is genuinely composed, handed
to SMTP, and captured by Mailpit — verified by reading it back out of the Mailpit API,
including the signed acceptance link. The collaborator page renders from that link and
exposes none of the creator's private data (no prohibited topics, fit scores, rival
candidate names, or reliability scores). Circle add is idempotent, and a failed Circle
mutation leaves the campaign at `circle_add_pending` with the membership stored as `failed`
— never `circle_added`, and with no brief or deliverable created behind it.

**Since proven (§1):** `addCircleMembers` ran against `api.build.hellominds.ai` and created
a real party, confirmed independently with `minds circle show`. That run also exposed the
all-zero mutation summary documented in §3.1 — the read-back confirmation described above is
precisely what stopped a successful add being reported as a failure.

Related UI honesty note: when the platform Circle cannot be read, the Room marks the stored
membership row as "Unverified right now" rather than presenting the last known status as
current fact.

### What Milestone 3 has and has not proven

**Proven** (130 tests, integration suite against real Postgres): the objective → ranking →
approval pipeline, structured-output validation with exactly one repair retry, the
brand-safety override, both human-control gates, and the failure paths.

**Since proven (§1):** the real Mind ranked Mira first with `fit 96` on the smallest audience,
citing her stored collaboration history, and rejected Nova on brand-safety grounds without
needing CollabOS's override. Reproduced across two independent runs.

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
The summary counters, however, are **not populated** — see §3.1 below.

### 3.1 The Circle mutation summary returns all zeros, even on success

Discovered by live testing on 2026-07-30, and the single most consequential platform quirk
found in this project. A Circle add that genuinely created a new party returned:

```json
{"activated":0,"humansAdded":0,"humansCreatedAndAdded":0,"alreadyInCircle":0,"totalProcessed":0}
```

The member was verifiably present afterwards (`minds circle show` confirmed
`partyId 578d31f5-…`, `isSteward:false`). So the mutation worked and the report said nothing
happened.

Any implementation treating `summary.humansAdded > 0` as "the add succeeded" — the most natural
reading of the response shape — would report **failure on a working mutation** and strand the
campaign at `circle_add_failed`. CollabOS avoids this only because success is defined as
re-reading the Circle and finding the member, never as trusting the platform's own report.

Documentation that previously described the summary as the idempotency signal has been
corrected in `docs/implementation-plan.md`, `docs/security-and-approvals.md`, and the
`minds:smoke` checklist.

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

### Cognition is billed per Mind, with no campaign dimension

`getCognitionUsageByTool()` reports spend per tool for the whole Mind. The Builder API
offers no way to attribute cognition to a campaign, a conversation, or a single question,
so the report's "Cognition spent by tool" panel is **Mind-wide** — it includes smoke tests
and every earlier campaign. The panel states that on its face; presenting the figure as
one campaign's cost would be the fabricated metric §18 prohibits.

Two further notes on this endpoint:

- `interval` accepts `hour | day | week | month` **only**, unlike `getCognitionUsage()`
  which also takes `1m`, `5m`, `15m`, `1h`, `1d`, `1w`, `1M`. Passing a fine-grained value
  here is a silent contract mismatch.
- Observed tools on this Mind are `LLM_Turn`, `SKILL_LoadPlaybook`, `ANALYST_Synthesize`,
  and `CONTENT_Write`. Which internal tool a given prompt triggers is the platform's
  decision, not something a builder selects, so CollabOS cannot map a tool row back to a
  specific campaign step.

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
