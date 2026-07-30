/**
 * Demo reset (CLAUDE.md §22, Milestone 7).
 *
 * Usage:
 *   npm run demo:reset              # clear campaign state, restore seeded memory
 *   npm run demo:reset -- --keep-memory   # clear campaigns, leave relationship history
 *
 * Restores the repository to a clean pre-demo state so a run can be repeated. By default it
 * also resets relationship memory to the seeded baseline — a second demo take should start
 * from Mira at one collaboration and reliability 0.95, not from whatever the previous take
 * left behind.
 *
 * Does NOT touch the Mind's Circle. Circle membership is a real platform permission, so
 * removing it is a separate, explicit action: `npm run circle:cleanup`.
 */
import "dotenv/config";

import { prisma } from "../src/lib/db.ts";
import { resetCampaignState, seedDemoScenario } from "../src/lib/seed/demo-seed.ts";

async function main(): Promise<void> {
  const keepMemory = process.argv.includes("--keep-memory");

  const before = await prisma.campaign.count();
  console.log(`Clearing ${before} campaign(s) and all associated records…`);

  await resetCampaignState(prisma);

  if (keepMemory) {
    console.log("Relationship memory left as-is (--keep-memory).");
  } else {
    await seedDemoScenario(prisma);
    console.log("Relationship memory restored to the seeded baseline.");
  }

  const relationships = await prisma.relationship.findMany({
    include: { partner: true },
    orderBy: { partner: { name: "asc" } },
  });

  console.log("\nCurrent relationship memory:");
  for (const relationship of relationships) {
    console.log(
      `  ${relationship.partner.name.padEnd(13)} ${relationship.status.padEnd(13)} ` +
        `${relationship.collaborationCount} collab(s), reliability ` +
        `${relationship.reliabilityScore ?? "none"}`,
    );
  }

  const mailpit = `http://${process.env.MAILPIT_HOST ?? "localhost"}:${
    process.env.MAILPIT_HTTP_PORT ?? "8025"
  }`;

  console.log("\nReady for a fresh demo run.");
  console.log(`  Captured test email is NOT cleared — empty it at ${mailpit} if you want a`);
  console.log(`  clean inbox for the demo.`);
  console.log(`  Circle membership is NOT cleared — use \`npm run circle:cleanup\` for that.`);
}

main()
  .catch((error: unknown) => {
    console.error("demo:reset failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
