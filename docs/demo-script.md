# Two-Minute Demo Script

> **Closing line:** *CollabOS didn't recommend a collaboration. It ran one.*

---

## Before you start (5 minutes, off camera)

```bash
npm run infra:up          # Postgres + Mailpit
npm run db:migrate
npm run demo:reset        # clean campaigns, restore seeded memory
```

Set in `.env`:

```env
MINDS_BUILDER_API_KEY=<your key>
MINDS_MIND_ID=<your mindId>
COLLABORATOR_TEST_EMAIL=<an inbox you control>
FOLLOW_UP_DELAY_SECONDS=180      # 60 for a tighter demo
APP_URL=http://localhost:3000    # must match the port you actually serve on
```

Verify, then open three things:

```bash
npm run minds:smoke       # all checks should pass
npm run dev               # terminal 1
npm run worker -- --interval 3000   # terminal 2 — leave it visible
```

- Browser tab 1 → <http://localhost:3000>
- Browser tab 2 → <http://localhost:8025> (Mailpit)
- Terminal 2 visible on screen — the worker output is the proof of autonomy

> **Never demo with `COLLABOS_UNSAFE_FIXTURE_MIND=1`.** It shows a red banner for exactly this
> reason. Canned responses prove nothing.

---

## The script

### 0:00 — The problem (15s)

> "Creator collaborations move real audiences, but the operator work is brutal: find partners,
> research them, write outreach, chase replies, brief, coordinate deadlines, collect
> deliverables, approve, measure. Most AI tools recommend a creator and stop.
>
> CollabOS is a persistent Creator Partnership Director. **The creator chooses the
> relationship. CollabOS runs everything in between.**"

### 0:15 — Memory that decides (25s)

Command Center. Point at **Creator brand memory**.

> "This is Maya. Web3 safety education, beginner audience, calm evidence-based voice — and hard
> boundaries: no gambling, no leverage trading, no token shilling. Below that, her real
> relationship history."

Type the objective, submit.

> "One objective. CollabOS loads her brand memory and relationship history from Postgres and
> sends it to the Mind as structured context."

### 0:40 — The decision (25s)

Go to **Partner Review**.

> "Three candidates. Mira has **48,000** followers. Alex has 210,000. Nova has 540,000.
>
> The Mind ranked **Mira first** — the smallest audience. Look at *Memory used*: completed one
> previous collaboration on time, engagement score 0.82, prefers concise communication. That's
> not decoration; it's why she won.
>
> Alex is 'consider with caution' — larger, but weaker alignment and he declined once over
> scheduling. The Mind cites the reason.
>
> Nova has the biggest audience and is **blocked outright**. High-risk trading calls collide
> with Maya's boundaries, and the approve control is gone — not greyed out, gone. CollabOS
> enforces that boundary itself, regardless of what the Mind says."

### 1:05 — Human control, twice (15s)

Approve Mira. Go to the **Collaboration Room**.

> "Approving Mira does **not** authorise contacting her. That's a separate decision."

Approve outreach. Open Mailpit.

> "The Mind wrote this in Maya's voice, referencing their history. Delivered through a **local
> test transport** — labelled everywhere, never touches the internet."

### 1:20 — The collaborator (15s)

Click the acceptance link from the email. Accept.

> "Mira accepts through a signed link — no account needed. She sees the shared brief the Mind
> just authored and her deliverable. She cannot see Maya's boundaries, the fit scores, or that
> she was ranked against anyone."

Back to the Room.

> "She's now in the Mind's **trusted Circle** — a real permission change on the platform."

### 1:35 — Autonomy (20s)

**Point at terminal 2. Do not touch the browser.**

> "The deliverable now has a deadline. Watch the worker — a separate process. I'm not clicking
> anything. There is no 'Follow Up' button in this product at all."

Wait for the worker line, then let the page auto-refresh.

> "Deadline passed. The worker claimed the campaign, asked the Mind for wording that matches
> Mira's stated preference, and sent one reminder. Exactly one — capped in the database, not in
> application logic."

### 1:55 — Close the loop (20s)

Submit the deliverable as Mira. Approve it as Maya. Open **Report**.

> "Completed. And here's the part that matters: **relationship memory updated.** Mira goes from
> one collaboration to two, and her reliability score moves — computed from what CollabOS
> actually observed: did she hit the deadline, did she need chasing.
>
> Note what this report *refuses* to claim. No view counts, no follower deltas. CollabOS has no
> analytics integration, so it doesn't invent one.
>
> And every step is in the audit log — proposed, approved, attempted, succeeded, failed, each
> recorded separately."

### 2:15 — Closing line

> **"CollabOS didn't recommend a collaboration. It ran one."**

---

## If something fails on camera

Lean into it — the failure handling *is* a feature.

> "The Mind timed out. Notice CollabOS didn't invent a recommendation to cover it. The action is
> recorded as attempted-and-failed, the campaign is still recoverable, and there's a retry."

Everything is designed so a failure is honest rather than embarrassing: failed actions keep
`attemptedAt` set with `executedAt` null, and no state advances on a failed external call.

---

## Common setup mistakes

| Symptom | Cause |
| --- | --- |
| Red banner about fixture Mind | `COLLABOS_UNSAFE_FIXTURE_MIND=1` is set — unset it |
| "Mind not connected" | `MINDS_BUILDER_API_KEY` / `MINDS_MIND_ID` missing; run `npm run minds:smoke` |
| Acceptance link 404s | `APP_URL` doesn't match the port you're serving on |
| Follow-up never fires | Worker isn't running, or `nextActionAt` hasn't passed |
| Stale data from a previous take | `npm run demo:reset` |
| Old emails in Mailpit | Clear the inbox at <http://localhost:8025> |
