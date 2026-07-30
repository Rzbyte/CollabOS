# Demo Script

> **Closing line:** *CollabOS didn't recommend a collaboration. It ran one.*

---

## Read this first: measured Mind latency

An earlier version of this script assumed each step took seconds. It was written before
credentials existed, and it was wrong. Measured against the live platform
(`minimax/minimax-m3`) on 2026-07-30:

| Step | Mind latency |
| --- | --- |
| Partner ranking | **86–145 s** |
| Outreach wording | **137 s** |
| Circle add + brief authoring | **182 s** |
| Follow-up wording | **148 s** |
| Post-campaign debrief | **182 s** |
| **Full campaign, end to end** | **~12–13 minutes** |

**A 2-minute live demo is therefore impossible.** Do not try to script around it by talking
faster — plan for it. Two workable formats follow.

---

## Format A — 2-minute video (recommended)

Run the campaign to completion **before** recording, then narrate the real artifacts it
produced. Nothing is faked: every screen shows a genuine completed campaign, and the Activity
Log timestamps prove the worker acted on its own.

### Preparation (~20 min, off camera)

```bash
npm run infra:up
npm run db:migrate
npm run demo:reset
npm run minds:smoke          # must be 8/8 PASS
```

`.env` needs `MINDS_BUILDER_API_KEY`, `MINDS_MIND_ID`, a `COLLABORATOR_TEST_EMAIL` you control
**and that differs from your Minds account address** (the Steward is already in the Circle, so
using it makes the Circle add a no-op), and `APP_URL` matching the port you actually serve on.

Then run one full campaign through the UI, leaving the worker running in a second terminal.
Budget ~13 minutes. Keep the worker terminal output — you will show it.

Before recording: **do not** run `demo:reset` again, or you will erase what you are about to
present.

### The script

**0:00 — The problem (15 s)**

> "Creator collaborations move real audiences, but the operator work is brutal: find partners,
> research them, write outreach, chase replies, brief, coordinate deadlines, collect
> deliverables, approve, measure. Most AI tools recommend a creator and stop.
>
> CollabOS is a persistent Creator Partnership Director. **The creator chooses the
> relationship. CollabOS runs everything in between.**"

**0:15 — Memory that decides (25 s)** — Command Center

> "This is Maya. Web3 safety education, beginner audience, calm evidence-based voice — and hard
> boundaries: no gambling, no leverage trading, no token shilling. Below that, her real
> relationship history, in Postgres. One objective is all she submits."

**0:40 — The decision (30 s)** — Partner Review

> "Mira has **48,000** followers. Alex has 210,000. Nova has 540,000.
>
> The Mind ranked **Mira first** — the smallest audience. Look at *Memory used*: completed one
> collaboration on time, engagement 0.82, prefers concise communication. That's *why* she won.
>
> Alex is 'consider with caution' — larger, weaker alignment, and he declined once over
> scheduling. The Mind names the reason.
>
> Nova has the biggest audience and is **blocked**. High-risk trading collides with Maya's
> boundaries, and the approve control is gone — not greyed out, gone."

**1:10 — Human control, twice (15 s)** — Collaboration Room

> "Approving Mira did **not** authorise contacting her. That was a separate decision. Then the
> Mind wrote this outreach in Maya's voice, delivered through a **local test transport** —
> labelled everywhere, never touches the internet."

**1:25 — Circle + autonomy (25 s)** — Room, then the worker terminal

> "Mira accepted through a signed link — no account needed. She's now in the Mind's **trusted
> Circle**, a real permission change on the platform.
>
> Then the deadline passed." *(cut to worker terminal)* "This is a separate process. Nobody
> clicked anything — there is no 'Follow Up' button in this product at all. It claimed the
> campaign, asked the Mind for wording matching Mira's stated preference, and sent **one**
> reminder. Exactly one, capped in the database."

**1:50 — Close the loop (20 s)** — Report

> "Completed. And here's what matters: **relationship memory updated.** Mira went from one
> collaboration to two — and her reliability *dropped*, 0.95 to 0.75, because she genuinely
> delivered late and needed chasing. The system records what happened, not what flatters her.
>
> Note what this report **refuses** to claim: no view counts, no follower deltas. CollabOS has
> no analytics integration, so it doesn't invent one."

**2:10 — Close**

> **"CollabOS didn't recommend a collaboration. It ran one."**

---

## Format B — live walkthrough (~15 min)

For a longer format, or judges watching in real time. Same flow, but you fill the Mind's
thinking time with content that genuinely needs explaining rather than dead air.

| Time | Action | What to say while waiting |
| --- | --- | --- |
| 0:00 | Submit the objective | The problem, Maya's brand memory, the prohibited topics, all three candidates' history — ~90 s of real material |
| ~2:00 | Partner Review appears | The ranking, memory used, why Nova is blocked |
| 2:30 | Approve Mira, approve outreach | The two-gate design and why they are separate |
| ~5:00 | Outreach lands in Mailpit | Read the Mind's wording aloud; open the signed link |
| 5:30 | Accept as collaborator | What the collaborator can and cannot see |
| ~8:30 | Circle + brief appear | Circle as the platform's real trust gate |
| 8:30 | Point at the worker terminal | Autonomy: separate process, no button. Close the browser to prove it |
| ~11:00 | Follow-up sent | Read it aloud — note the offered extension |
| 11:30 | Submit + approve | The final human gate |
| ~14:30 | Report | Relationship write-back, and what the report refuses to claim |

Keep `FOLLOW_UP_DELAY_SECONDS=180` for this format so the deadline feels real. For a tighter
run, lower it to `30` — the mechanism is identical, only the window shrinks.

---

## Budget

**Cognition:** a full campaign costs **~15.4 cognition** (measured: 209.66 → 194.23). Check your
balance with `minds cognition balance --mind "$MINDS_MIND_ID"` and divide — at ~194 you have
roughly a dozen full runs. Use `npm run demo:reset` between takes rather than creating new
campaigns.

**Time:** ~13 minutes per full campaign. Plan two runs minimum — one rehearsal, one recording.

---

## If something fails on camera

Lean into it — the failure handling *is* a feature.

> "The Mind timed out. Notice CollabOS didn't invent a recommendation to cover it. The action is
> recorded as attempted-and-failed, the campaign is still recoverable, and there's a retry."

Failed actions keep `attemptedAt` set with `executedAt` null, and no state advances on a failed
external call. Nothing is designed to hide.

---

## Never demo with the fixture Mind

`COLLABOS_UNSAFE_FIXTURE_MIND=1` exists only so the Playwright test can run without
credentials. It forces a red banner onto every page for exactly this reason. Canned responses
prove nothing — check the banner is absent before recording.

---

## Common setup mistakes

| Symptom | Cause |
| --- | --- |
| Red banner about a fixture Mind | `COLLABOS_UNSAFE_FIXTURE_MIND=1` is set — unset it |
| "Mind not connected" | Credentials missing; run `npm run minds:smoke` |
| "could not produce recommendations" | `MINDS_REPLY_TIMEOUT_MS` too low — the ranking call needs 145 s, keep it at 240000 |
| Acceptance link 404s | `APP_URL` doesn't match the serving port |
| Circle add is a silent no-op | `COLLABORATOR_TEST_EMAIL` equals your Minds account address (the Steward is already a member) |
| Follow-up never fires | Worker isn't running, or `nextActionAt` hasn't passed |
| Everything looks stale | `npm run demo:reset` |
