# Test Plan

```bash
npm test               # 214 tests — unit + integration
npm run test:unit      # pure, no infrastructure needed
npm run test:integration
npm run test:e2e       # Playwright, 2 tests
```

Integration and E2E tests need `npm run infra:up` (Postgres + Mailpit).

---

## 1. Coverage against `CLAUDE.md` §20

### Required unit tests

| Requirement | Where |
| --- | --- |
| Legal campaign transitions | `tests/unit/campaign-states.test.ts` |
| Illegal campaign transitions | `tests/unit/campaign-states.test.ts` |
| Maximum one autonomous follow-up | `tests/integration/follow-up-worker.test.ts` |
| Rejected partner cannot be contacted | `recommendation-flow` + `follow-up-worker` |
| Brand-safety candidate is rejected or flagged | `tests/unit/brand-safety.test.ts` + `recommendation-flow` |
| Idempotent Circle addition | `tests/integration/circle-and-collaboration.test.ts` |
| Idempotent worker execution | `tests/integration/follow-up-worker.test.ts` |
| Zod validation and repair failure | `tests/unit/reasoning-repair.test.ts` |

### Required integration tests

| Requirement | Where |
| --- | --- |
| Seeded objective → partner recommendations | `recommendation-flow.test.ts` |
| Partner approval → Circle add attempt | `circle-and-collaboration.test.ts` |
| Overdue deliverable → autonomous follow-up | `follow-up-worker.test.ts` |
| Deliverable submission → final approval | `circle-and-collaboration.test.ts` |
| Campaign completion updates relationship history | `completion.test.ts` |
| Failed external action does not produce false success | all four integration files |

### Required end-to-end test

`tests/e2e/vertical-slice.spec.ts` drives the whole flow in Chromium: submit objective → review
candidates → approve Mira → approve first outreach → accept as collaborator → show Circle state
→ worker fires the follow-up → submit deliverable → approve deliverable → campaign completes →
report.

---

## 2. Time is injected, never waited on

`FOLLOW_UP_DELAY_SECONDS` defaults to 180. No test waits three minutes.

- **Unit + integration** inject `FixedClock` and call `advanceSeconds(181)`. The entire
  worker suite runs in ~14 seconds.
- **E2E** drives a real HTTP server in a separate process, so it shortens the configured
  deadline to 5 seconds instead. Same effect, no sleeping.

---

## 3. What is real in each layer

| Layer | Postgres | Mind | Email | Clock |
| --- | --- | --- | --- | --- |
| Unit | not used | not used | not used | injected |
| Integration | **real** | scripted port | recording transport | injected |
| E2E | **real** | fixture port (labelled) | **real Mailpit** | real, 5s deadline |

The scripted and fixture Minds are dependency injection for determinism. The production binding
is always `MindsClientAdapter` against the real client library. A scripted Mind lets tests
assert *CollabOS's* behaviour rather than a model's wording — but it means **no automated test
proves the Mind reasons well.** That gap is recorded in `docs/known-limitations.md`, not papered
over.

The E2E test runs with `COLLABOS_UNSAFE_FIXTURE_MIND=1`, which forces a red warning banner onto
every page and marks every stored exchange `fixtureMode: true`.

---

## 4. Notable assertions

Beyond happy paths, the suite pins the properties that make the audit trail trustworthy:

- **A failed action keeps `attemptedAt` and never gains `executedAt`.** Asserted in every
  integration file.
- **`succeeded <= attempted`, always.** A direct query for rows with `executedAt` set and
  `attemptedAt` null must return empty. This is a regression guard — human approvals were once
  routed through the execution lifecycle and produced an incoherent summary.
- **Human approvals carry no execution timestamps.** They are decisions, not executions.
- **A failed Circle mutation stores `failed`**, leaves the campaign at `circle_add_pending`, and
  creates no brief or deliverable behind it.
- **Two concurrent workers send exactly one follow-up** (`SKIP LOCKED`), and the
  `followUpCount` CAS still stands down when the lease is deliberately bypassed.
- **A revision round cannot re-arm the follow-up** — ties the M5 cap to the M6 loop.
- **A JWT in an error message never reaches the database.**
- **The collaborator page leaks no prohibited topics, fit scores, or rival candidate names.**
- **`performanceScore` is untouched when the creator reports nothing.**
- **Ranks must be 1..n with no duplicates, and every offered candidate must be ranked** —
  hallucination guards Zod alone cannot express.

---

## 5. Bugs these tests caught

Worth recording, because each was invisible to lint, typecheck, and build:

| Bug | Found by |
| --- | --- |
| `.js` import specifiers in `minds/client.ts` — `tsc` accepted them, Turbopack 500'd every page | loading the app |
| `IDLE` exported from a `"use server"` file — every form page failed to render | Playwright E2E |
| Pages had **no `<h1>`** — accessibility defect | Playwright E2E |
| Report claimed more successes than attempts | rendering the report and reading it |
| Fixture Mind ranked candidates alphabetically, recommending Alex over Mira | Playwright E2E |
| Eager Prisma construction made pure unit tests fail at import | running unit tests |

The pattern is consistent: the static gates verify the code compiles and behaves in isolation,
but only exercising the running product surfaces integration-level defects.

---

## 6. Known gaps

- **No test proves the real Mind reasons correctly.** Requires a Builder API key.
- **No test exercises a real Circle mutation** against `api.build.hellominds.ai`.
- **No accessibility audit tooling** (axe, Lighthouse). Manual basics only: single `<h1>` per
  page, skip link, `:focus-visible`, `role="status"`/`role="alert"` on live regions, `aria-busy`
  on pending buttons, labelled form controls, `prefers-reduced-motion` honoured.
- **No load or concurrency testing** beyond the two-worker race.
- **No visual regression testing.**
- **Coverage is not measured.** The suite is targeted at the spec's required behaviours rather
  than a line-coverage number.
