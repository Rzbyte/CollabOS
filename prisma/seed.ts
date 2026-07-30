/**
 * Seeds the demo scenario from CLAUDE.md §4.
 *
 * Run with:  npm run db:seed   (or `npm run db:reset` to wipe and reseed)
 *
 * Idempotent — every write is an upsert with a stable id, so re-running is safe between
 * demo takes. The data itself lives in `src/lib/seed/demo-seed.ts` so the integration
 * tests and the demo-reset script use exactly the same scenario.
 */
import "dotenv/config";

import { prisma } from "../src/lib/db.ts";
import { seedDemoScenario } from "../src/lib/seed/demo-seed.ts";

async function main(): Promise<void> {
  console.log("Seeding CollabOS demo scenario…\n");

  const result = await seedDemoScenario(prisma);

  const [creator, partners] = await Promise.all([
    prisma.creatorProfile.findUniqueOrThrow({ where: { id: result.creatorId } }),
    prisma.partner.findMany({ orderBy: { audienceSize: "asc" } }),
  ]);

  console.log(`  creator      ${creator.name} (${creator.id})`);
  console.log(`               alias "${creator.mindConversationAlias}" — reused every session`);
  console.log(`               prohibited: ${creator.prohibitedTopics.join(", ")}\n`);

  for (const partner of partners) {
    console.log(
      `  partner      ${partner.name.padEnd(12)} ${partner.niche}\n` +
        `               audience ${partner.audienceSize.toLocaleString("en-US").padStart(8)}` +
        `${partner.safetyFlags.length ? `  ⚠ flags: ${partner.safetyFlags.join(", ")}` : ""}`,
    );
  }

  console.log("\n  relationship memory:");
  console.log("    Mira  → collaborated once, on time, performance 0.82, reliability 0.95");
  console.log("    Alex  → declined once (scheduling conflict), reliability 0.55");
  console.log("    Nova  → no history; brand-safety conflict with prohibited topics");

  console.log("\nSeed complete.");
  console.log(
    "Note: all partners are synthetic and use the reserved @example.com domain, which " +
      "cannot receive mail.",
  );
}

main()
  .catch((error: unknown) => {
    console.error("Seed failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
