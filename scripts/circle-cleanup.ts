/**
 * Emergency Circle cleanup (CLAUDE.md §16).
 *
 * Removes a human collaborator from the configured Mind's Circle when a campaign has been
 * abandoned, a demo needs resetting, or something went wrong mid-flow.
 *
 * Usage:
 *   npm run circle:cleanup -- --dry-run          # show what would happen (default)
 *   npm run circle:cleanup -- --yes              # remove COLLABORATOR_TEST_EMAIL
 *   npm run circle:cleanup -- --email a@b.com --yes
 *   npm run circle:cleanup -- --list             # just read current membership
 *
 * Safety choices:
 *   • Dry-run is the DEFAULT. Removing Circle access is a real permission change, so it
 *     requires an explicit `--yes`.
 *   • The Steward is never targeted — the platform makes the creator permanent, and
 *     attempting it would be a pointless failing call.
 *   • Mind platform addresses are refused, matching the rest of the codebase.
 */
import "dotenv/config";

import { describeEnv, loadEnv } from "../src/env.ts";
import { MindsClientAdapter, assertHumanCollaboratorEmail } from "../src/lib/minds/client.ts";
import { toCollabOsMindsError } from "../src/lib/minds/errors.ts";

interface Options {
  email: string | null;
  confirm: boolean;
  listOnly: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { email: null, confirm: false, listOnly: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes" || arg === "-y") options.confirm = true;
    else if (arg === "--dry-run") options.confirm = false;
    else if (arg === "--list") options.listOnly = true;
    else if (arg === "--email") {
      const next = argv[i + 1];
      if (!next) throw new Error("--email requires a value");
      options.email = next;
      i += 1;
    }
  }

  return options;
}

function maskEmail(email: string | undefined): string {
  if (!email) return "(no email)";
  const [local, domain] = email.split("@");
  if (!local || !domain) return "(masked)";
  return `${local.slice(0, 1)}${"*".repeat(Math.max(1, local.length - 2))}${
    local.length > 2 ? local.slice(-1) : ""
  }@${domain}`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const status = describeEnv();

  if (!status.mindsConfigured) {
    console.error(
      `Cannot manage the Circle: Mind is not connected. Missing ${status.missing.join(", ")}.\n` +
        `See docs/minds-smoke-test.md for the setup checklist.`,
    );
    process.exitCode = 1;
    return;
  }

  const env = loadEnv();
  const adapter = new MindsClientAdapter();

  // ------------------------------------------------------------ read current state
  let members;
  try {
    members = await adapter.getCircle();
  } catch (error) {
    console.error(`Failed to read Circle: ${toCollabOsMindsError(error).message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nCircle members (${members.length}):`);
  for (const member of members) {
    const role = member.isSteward ? "steward (permanent)" : "collaborator";
    console.log(`  • ${maskEmail(member.email)}  [${role}]`);
  }

  if (options.listOnly) return;

  // ------------------------------------------------------------- choose the target
  const target = (options.email ?? env.COLLABORATOR_TEST_EMAIL).trim().toLowerCase();

  if (!target) {
    console.error(
      "\nNo target address. Set COLLABORATOR_TEST_EMAIL in .env or pass --email <address>.",
    );
    process.exitCode = 1;
    return;
  }

  try {
    assertHumanCollaboratorEmail(target);
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  const match = members.find((member) => member.email?.toLowerCase() === target);

  if (!match) {
    console.log(`\n${maskEmail(target)} is not in the Circle — nothing to do.`);
    return;
  }

  if (match.isSteward) {
    console.error(
      `\nRefusing to remove ${maskEmail(target)}: this is the Mind's Steward, which the ` +
        `platform makes permanent.`,
    );
    process.exitCode = 1;
    return;
  }

  // ---------------------------------------------------------------------- act
  if (!options.confirm) {
    console.log(
      `\nDRY RUN — would remove ${maskEmail(target)} from the Circle.\n` +
        `Re-run with --yes to actually remove.`,
    );
    return;
  }

  try {
    const result = await adapter.removeCircleMember(target);
    console.log(
      `\n${result.outcome === "removed" ? "Removed" : "Was not a member"}: ` +
        `${maskEmail(target)}. Circle now has ${result.members.length} member(s).`,
    );
  } catch (error) {
    console.error(`\nRemoval failed: ${toCollabOsMindsError(error).message}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error("circle:cleanup crashed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
