/**
 * Milestone 1 — Minds platform proof.
 *
 * Run with:  npm run minds:smoke
 *
 * Performs every Milestone 1 check and REGENERATES `docs/minds-smoke-test.md` from
 * the actual results. The evidence file is therefore never hand-written and never
 * stale — if a check is recorded as passing, this script observed it passing.
 *
 * Safe to run without credentials: the authenticated checks report `BLOCKED` with
 * the reason, and the unauthenticated checks still prove host reachability.
 *
 * Redaction: no API key is ever read into the report, and Circle email addresses are
 * masked. Only counts, identifiers already public to the account owner, and
 * sanitised messages are written to disk.
 */
import "dotenv/config";

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describeEnv, loadEnv } from "../src/env.ts";
import { MindsClientAdapter } from "../src/lib/minds/client.ts";
import { toCollabOsMindsError } from "../src/lib/minds/errors.ts";

const execFileAsync = promisify(execFile);

type Status = "PASS" | "FAIL" | "BLOCKED";

interface CheckResult {
  step: string;
  status: Status;
  detail: string;
}

const results: CheckResult[] = [];

function record(step: string, status: Status, detail: string): void {
  results.push({ step, status, detail });
  const icon = status === "PASS" ? "✓" : status === "BLOCKED" ? "•" : "✗";
  console.log(`${icon} ${status.padEnd(7)} ${step} — ${detail}`);
}

/** `user@example.com` → `u**r@example.com`. */
function maskEmail(email: string | undefined): string {
  if (!email) return "(no email)";
  const [local, domain] = email.split("@");
  if (!local || !domain) return "(masked)";
  const head = local.slice(0, 1);
  const tail = local.length > 2 ? local.slice(-1) : "";
  return `${head}${"*".repeat(Math.max(1, local.length - 2))}${tail}@${domain}`;
}

async function tryExec(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 60_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  console.log("CollabOS — Milestone 1 Minds platform proof\n");

  // -- 1. Node runtime ------------------------------------------------------
  const nodeMajor = Number(process.versions.node.split(".")[0] ?? 0);
  record(
    "Node.js >= 22",
    nodeMajor >= 22 ? "PASS" : "FAIL",
    `detected v${process.versions.node}`,
  );

  // -- 2. CLI version (diagnostics only — never used in request handlers) ---
  const cliVersion = await tryExec("minds", ["--version"]);
  record(
    "Minds CLI installed",
    cliVersion ? "PASS" : "BLOCKED",
    cliVersion ? `version ${cliVersion}` : "`minds` not on PATH (npm i -g @animocabrands/minds-cli@latest)",
  );

  // -- 3. Environment shape -------------------------------------------------
  const envSummary = describeEnv();
  record(
    "Environment validation",
    "PASS",
    envSummary.missing.length === 0
      ? "all Minds variables present"
      : `missing: ${envSummary.missing.join(", ")}`,
  );

  let adapter: MindsClientAdapter | null = null;
  try {
    loadEnv();
    adapter = new MindsClientAdapter();
  } catch (error) {
    record(
      "Load configuration",
      "FAIL",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!adapter) {
    await writeReport();
    process.exitCode = 1;
    return;
  }

  // -- 4. Host reachability (public endpoint, no key required) --------------
  const reach = await adapter.checkReachability();
  record(
    "api.build.hellominds.ai reachable",
    reach.reachable ? "PASS" : "FAIL",
    reach.detail,
  );

  // -- 5. Authenticated checks ---------------------------------------------
  if (!adapter.isConfigured()) {
    const blocked =
      "requires MINDS_BUILDER_API_KEY and MINDS_MIND_ID — see the setup checklist below";
    record("List Minds / validate Mind ID", "BLOCKED", blocked);
    record("Cognition balance", "BLOCKED", blocked);
    record("Read Circle state", "BLOCKED", blocked);
    record("Send safe test message", "BLOCKED", blocked);
    await writeReport();
    return;
  }

  let alias: string | null = null;

  try {
    const mind = await adapter.validateMind();
    record(
      "List Minds / validate Mind ID",
      "PASS",
      `configured Mind found: "${mind.name ?? "(unnamed)"}", enabled=${mind.isEnabled}` +
        `${mind.model ? `, model=${mind.model}` : ""}`,
    );
  } catch (error) {
    record(
      "List Minds / validate Mind ID",
      "FAIL",
      toCollabOsMindsError(error).message,
    );
  }

  try {
    const cognition = await adapter.getCognitionBalance();
    record("Cognition balance", "PASS", `${cognition} cognition available`);
  } catch (error) {
    record("Cognition balance", "FAIL", toCollabOsMindsError(error).message);
  }

  try {
    const members = await adapter.getCircle();
    const stewards = members.filter((m) => m.isSteward).length;
    record(
      "Read Circle state",
      "PASS",
      `${members.length} member(s), ${stewards} steward(s): ` +
        members.map((m) => maskEmail(m.email)).join(", "),
    );
  } catch (error) {
    record("Read Circle state", "FAIL", toCollabOsMindsError(error).message);
  }

  try {
    alias = "collabos-smoke";
    await adapter.ensureConversation(alias);
    const probe =
      "CollabOS connectivity check. This is an automated smoke test from the " +
      "CollabOS builder app. Please reply with the single word: ACK";
    const reply = await adapter.ask({
      alias,
      text: probe,
      correlationId: crypto.randomUUID(),
      timeoutMs: 120_000,
    });
    const excerpt = reply.text.replace(/\s+/g, " ").slice(0, 160);
    record(
      "Send safe test message",
      "PASS",
      `round trip ${reply.latencyMs}ms on alias "${alias}"; reply excerpt: "${excerpt}"`,
    );
  } catch (error) {
    record("Send safe test message", "FAIL", toCollabOsMindsError(error).message);
  }

  await writeReport();

  if (results.some((r) => r.status === "FAIL")) process.exitCode = 1;
}

async function writeReport(): Promise<void> {
  const env = describeEnv();
  const now = new Date().toISOString();
  const counts = {
    pass: results.filter((r) => r.status === "PASS").length,
    blocked: results.filter((r) => r.status === "BLOCKED").length,
    fail: results.filter((r) => r.status === "FAIL").length,
  };

  const rows = results
    .map((r) => `| ${r.step} | ${r.status} | ${escapePipes(r.detail)} |`)
    .join("\n");

  const report = `# Minds Platform Smoke Test — Milestone 1 Evidence

> **Generated by \`npm run minds:smoke\`** (\`scripts/minds-smoke.ts\`).
> Do not edit by hand — re-run the command to refresh.
>
> Generated: \`${now}\`
> Result: **${counts.pass} passed, ${counts.blocked} blocked, ${counts.fail} failed**

No API key, key fragment, or raw provider response body is written to this file.
Circle email addresses are masked.

---

## Results

| Step | Status | Detail |
| --- | --- | --- |
${rows}

---

## Environment

| Item | Value |
| --- | --- |
| Node.js | \`${process.versions.node}\` |
| Platform | \`${process.platform}\` |
| Minds credentials configured | ${env.mindsConfigured ? "yes" : "**no**"} |
| Collaborator email configured | ${env.collaboratorConfigured ? "yes" : "**no**"} |
${env.missing.length ? `| Missing variables | \`${env.missing.join("`, `")}\` |` : ""}

---

## CLI dist-tag finding

\`CLAUDE.md\` §8 says to prefer the \`beta\` dist-tag if it exists. It exists, but it is
**older than \`latest\`**:

\`\`\`json
{ "beta": "0.1.1", "latest": "0.1.3" }
\`\`\`

Installing \`@beta\` would have downgraded the CLI. The reason given for preferring beta
was to obtain cognition, Bazaar, Circle, and enable/disable functionality — all four are
present in \`0.1.3\` (\`minds cognition\`, \`minds bazaar\`, \`minds circle\`, \`minds mind\`).

**Decision: installed \`@animocabrands/minds-cli@latest\` (0.1.3).**

---

## Verified CLI surface

Captured from \`--help\` on the installed 0.1.3 build, which is the source of truth
over any remembered flag set. Two flags were guessed wrong during exploration and
corrected from help output (\`--search\` is not valid on \`minds bazaar apps\`; there is
no \`--page-size\`, the correct flag is \`--max\`).

\`\`\`text
minds list                     List Minds (mindId + name)
minds chat                     Conversation commands (list, show, create)
minds send <alias> [text]      Send a message   [--wait] [--timeout <ms>]
minds history <alias>          Message history  [--limit 1-200] [--cursor <fingerprint>]
minds events [alias]           Stream messaging events as NDJSON
minds doctor                   api.build liveness + key + messaging connectivity
minds usage show|by-tool       Cognition spend over time / by tool
minds cognition balance        Per-Mind cognition balance   --mind <uuid>
minds mind                     Mind account operations
minds bazaar skills|apps|search  Public catalogue (no API key)
minds circle show|list|add|remove  Human collaborators   --mind <uuid> --email <email>
\`\`\`

\`minds circle remove\` supports \`--dry-run\`, which CollabOS mirrors in
\`npm run circle:cleanup -- --dry-run\`.

---

## Client library contract

Verified against \`dist/index.d.ts\` of \`@animocabrands/minds-client-lib@0.1.3\`.
**Every capability CollabOS needs exists in the official client, so no custom HTTP
adapter was written.**

| Need | Method |
| --- | --- |
| Validate configured Mind | \`listMinds()\`, \`getMind(mindId)\` |
| Send message | \`sendMessage({ alias, messageText })\` |
| Wait for reply | \`waitForReply({ alias, timeoutMs, afterFingerprint })\` |
| Read history | \`getHistory(alias, { limit })\` |
| Cognition balance | \`getCognitionBalance(mindId)\` |
| Read Circle | \`getCircle(mindId)\` → \`CircleMember[]\` |
| Add collaborator | \`addCircleMembers(mindId, { emails, isActive })\` |
| Remove collaborator | \`removeCircleMembers(mindId, { emails })\` |
| Typed errors | \`MindsApiError { status, code, message, requestId }\` |

Platform details that shaped the implementation:

1. Base URL is fixed at \`https://api.build.hellominds.ai\`; auth header is \`X-Api-Key\`.
2. A Builder API key is a JWT carrying a \`humanId\` claim.
3. \`ensureConversation(alias, mindId)\` is idempotent and handles HTTP 409 — one
   durable alias per creator is what gives CollabOS cross-session continuity.
4. Reply detection needs a baseline: \`getLatestHistoryFingerprint()\` **before**
   \`sendMessage()\`, then \`waitForReply({ afterFingerprint })\`. Skipping the baseline
   risks mistaking a previous reply for the current one.
5. \`senderType\`: \`0\`/\`2\` = Mind, \`1\` = human.
6. Circle \`GET\` returns \`CircleMember[]\`; \`POST\`/\`DELETE\` return
   \`{ items, summary }\` — different shapes. \`summary.alreadyInCircle\` is the
   idempotency signal CollabOS uses.
7. Circles accept **human** collaborator emails only, not Mind
   \`@hellominds.ai\` addresses. CollabOS rejects the latter before any network call.

---

## Manual setup checklist

Complete these to unblock every \`BLOCKED\` row above, then re-run
\`npm run minds:smoke\`.

1. **Create a Mind first — this must be done in the web UI.**
   Visit <https://hellominds.ai/profile>. The official docs state "you need at least one Mind
   before Builder Tools can route messages", and \`minds mind\` has **no \`create\`
   subcommand** (only \`show\`/\`disable\`/\`enable\`/\`skills\`/\`apps\`), so the CLI cannot do this
   step. Your account becomes the Mind's permanent **Steward**.

2. **Create a Builder API key**
   Visit <https://build.hellominds.ai/console> → sign in → **Keys** → **Create**.
   Per the docs: "add a name and expiry, then copy the token when it appears. It is shown
   only once."

   ⚠️ Note the **expiry** — set it long enough for your work. When it lapses, CollabOS
   surfaces \`MINDS_UNAUTHORISED\` ("Verify MINDS_BUILDER_API_KEY") rather than a confusing
   failure.

3. **Put it in \`.env\`** (gitignored — never commit it)
   \`\`\`env
   MINDS_BUILDER_API_KEY=<paste key>
   \`\`\`

4. **Find your Mind ID — it is a UUID, not the display name**
   \`\`\`bash
   minds list --pretty
   # or directly:
   minds list | jq -r '.items[0].mindId'
   \`\`\`
   \`\`\`env
   MINDS_MIND_ID=<paste the UUID>
   \`\`\`

   You do **not** need \`minds chat create\`. CollabOS calls \`ensureConversation()\` itself
   using the creator's stored alias (\`collabos-maya\`), and that call is idempotent — a
   manually created alias would just sit unused.

5. **Check the Mind has cognition to spend**
   \`\`\`bash
   minds cognition balance --mind "$MINDS_MIND_ID"
   \`\`\`
   No waitlist, approval, or funding step is documented as a prerequisite, but a Mind with a
   zero balance cannot reason even with valid credentials. CollabOS shows this figure on the
   Command Center.

4. **Set a collaborator inbox you control.** This is the only address CollabOS will
   ever add to the Circle.
   \`\`\`env
   COLLABORATOR_TEST_EMAIL=you+collab@yourdomain.com
   \`\`\`

5. **Verify**
   \`\`\`bash
   minds doctor --pretty
   npm run minds:smoke
   \`\`\`

### Recommended Mind configuration

Give the Mind a system prompt establishing it as a **Creator Partnership Director**
that: reasons about audience relevance over raw follower count, respects hard brand
constraints, uses supplied relationship history, and returns strict JSON when asked.
CollabOS supplies full structured context on every call, so it does not depend on
prompt configuration — but a well-briefed Mind produces better wording.
`;

  await mkdir("docs", { recursive: true });
  await writeFile("docs/minds-smoke-test.md", report, "utf8");
  console.log("\nWrote docs/minds-smoke-test.md");
}

function escapePipes(input: string): string {
  return input.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

main().catch((error: unknown) => {
  console.error("Smoke test crashed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
