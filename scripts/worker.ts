/**
 * Autonomous follow-up worker — development runner.
 *
 * Usage:
 *   npm run worker          # continuous polling loop (Ctrl-C to stop)
 *   npm run worker:once     # single pass, then exit (used by tests and CI)
 *   npm run worker -- --interval 2000
 *
 * This is a SEPARATE PROCESS from the Next.js app on purpose. CLAUDE.md §3 requires that
 * autonomy is not faked with a button, and running the trigger outside the request/response
 * cycle is what makes that verifiable: you can close the browser entirely and the follow-up
 * still fires.
 */
import "dotenv/config";

import { describeEnv } from "../src/env.ts";
import { prisma } from "../src/lib/db.ts";
import { getEmailTransport } from "../src/lib/email/transport.ts";
import { runFollowUpPass } from "../src/worker/follow-up.ts";

interface Options {
  once: boolean;
  intervalMs: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { once: false, intervalMs: 5000 };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once") options.once = true;
    else if (arg === "--interval") {
      const next = Number(argv[i + 1]);
      if (Number.isFinite(next) && next >= 250) options.intervalMs = next;
      i += 1;
    }
  }

  return options;
}

function stamp(): string {
  return new Date().toISOString().replace("T", " ").slice(11, 19);
}

let shuttingDown = false;

async function pass(): Promise<void> {
  const result = await runFollowUpPass({ workerId: `worker-${process.pid}` });

  if (result.claimed === 0) return;

  console.log(`${stamp()}  claimed ${result.claimed} campaign(s)`);
  for (const item of result.results) {
    const icon =
      item.outcome === "sent" ? "→" : item.outcome === "failed" ? "✗" : "·";
    console.log(`${stamp()}  ${icon} ${item.campaignId} ${item.outcome} — ${item.detail}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const env = describeEnv();
  const transport = getEmailTransport();

  console.log("CollabOS autonomous follow-up worker");
  console.log(`  mode        ${options.once ? "single pass" : `polling every ${options.intervalMs}ms`}`);
  console.log(`  transport   ${transport.label}`);
  console.log(
    `  mind        ${env.mindsConfigured ? "connected" : `NOT CONNECTED (missing ${env.missing.join(", ")})`}`,
  );

  if (!env.mindsConfigured) {
    console.log(
      "\n  The worker will still claim overdue campaigns and record the attempt, but the\n" +
        "  Mind call will fail and be logged as a failure. No follow-up text will be\n" +
        "  invented to cover the gap.",
    );
  }
  console.log("");

  if (options.once) {
    await pass();
    console.log(`${stamp()}  single pass complete`);
    return;
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (shuttingDown) process.exit(1);
      shuttingDown = true;
      console.log(`\n${stamp()}  shutting down after the current pass…`);
    });
  }

  while (!shuttingDown) {
    try {
      await pass();
    } catch (error) {
      // A failed pass must not kill the worker — the next one may succeed.
      console.error(
        `${stamp()}  pass failed:`,
        error instanceof Error ? error.message : error,
      );
    }

    if (shuttingDown) break;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }
}

main()
  .catch((error: unknown) => {
    console.error("worker crashed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
