/**
 * Validated environment configuration.
 *
 * SERVER-SIDE ONLY. No variable here is prefixed `NEXT_PUBLIC_`, so none of it can
 * be inlined into a client bundle. `MINDS_BUILDER_API_KEY` in particular must never
 * cross to the browser.
 *
 * Design note: the app boots with the Minds credentials ABSENT. That is a supported
 * state, not a crash — CollabOS then reports the Mind as disconnected and refuses to
 * fabricate reasoning. Only genuinely local infrastructure (database, app URL) is
 * hard-required, because without those nothing can run at all.
 */
import { z } from "zod";

/** Fallback used only when LINK_SIGNING_SECRET is unset in local development. */
const DEV_SIGNING_SECRET = "collabos-dev-only-insecure-signing-secret";

const EnvSchema = z.object({
  // --- Minds platform: optional at boot, required for any Mind-backed feature ---
  MINDS_BUILDER_API_KEY: z.string().trim().default(""),
  MINDS_MIND_ID: z.string().trim().default(""),

  // --- Circle collaborator ---
  // Allowed to be blank at boot; the Circle step validates it is a real address
  // before attempting a mutation.
  COLLABORATOR_TEST_EMAIL: z
    .union([z.email(), z.literal("")])
    .default(""),

  // --- Hard requirements ---
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (url) => url.startsWith("postgresql://") || url.startsWith("postgres://"),
      // Guards the spec rule "do not silently replace PostgreSQL with SQLite".
      "DATABASE_URL must be a PostgreSQL connection string — CollabOS requires " +
        "PostgreSQL (arrays, enums, SELECT … FOR UPDATE SKIP LOCKED) and will not run on SQLite",
    ),
  APP_URL: z.url("APP_URL must be an absolute URL, e.g. http://localhost:3000"),

  // --- Local test email transport ---
  EMAIL_TRANSPORT: z.enum(["mailpit", "console"]).default("mailpit"),
  MAILPIT_HOST: z.string().min(1).default("localhost"),
  MAILPIT_SMTP_PORT: z.coerce.number().int().positive().max(65535).default(1025),
  MAILPIT_HTTP_PORT: z.coerce.number().int().positive().max(65535).default(8025),

  // --- Autonomy timing ---
  FOLLOW_UP_DELAY_SECONDS: z.coerce.number().int().positive().default(180),

  /**
   * Mind reply timeout.
   *
   * Measured against the live platform: a partner-ranking call on `minimax/minimax-m3` took
   * **144 seconds**. The original 120s default therefore timed out on a perfectly healthy
   * Mind and surfaced as "could not produce recommendations", which was misleading. 240s
   * gives ~66% headroom over the observed worst case while still failing in a bounded time.
   *
   * Note this timeout is NOT retried inside `ask()` — a duplicate `sendMessage` would post
   * the same question twice — so raising it does not multiply the wait.
   */
  MINDS_REPLY_TIMEOUT_MS: z.coerce.number().int().positive().default(240_000),

  LINK_SIGNING_SECRET: z.string().default(""),
});

export type CollabOsEnv = z.infer<typeof EnvSchema> & {
  /** True only when BOTH a Builder API key and a Mind ID are present. */
  readonly mindsConfigured: boolean;
  /** True when a collaborator address is configured for Circle mutations. */
  readonly collaboratorConfigured: boolean;
  readonly signingSecret: string;
  /** Deep-link base for inspecting captured test email. */
  readonly mailpitWebUrl: string;
};

let cached: CollabOsEnv | null = null;

/**
 * Parses and caches the environment.
 *
 * Throws a single aggregated, value-free error so a misconfiguration is obvious at
 * startup instead of surfacing as a confusing runtime failure. Error text lists
 * variable NAMES and reasons only — never values, so this is safe to log.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): CollabOsEnv {
  if (cached) return cached;

  const parsed = EnvSchema.safeParse(source);

  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const key = issue.path.join(".") || "(root)";
      return `  • ${key}: ${issue.message}`;
    });
    throw new Error(
      `Invalid CollabOS environment configuration:\n${problems.join("\n")}\n\n` +
        `Copy .env.example to .env and fill in the values.`,
    );
  }

  const value = parsed.data;

  cached = {
    ...value,
    mindsConfigured: value.MINDS_BUILDER_API_KEY !== "" && value.MINDS_MIND_ID !== "",
    collaboratorConfigured: value.COLLABORATOR_TEST_EMAIL !== "",
    signingSecret:
      value.LINK_SIGNING_SECRET !== "" ? value.LINK_SIGNING_SECRET : DEV_SIGNING_SECRET,
    mailpitWebUrl: `http://${value.MAILPIT_HOST}:${value.MAILPIT_HTTP_PORT}`,
  };

  return cached;
}

/** Test-only: drop the memoised config so a fresh environment can be parsed. */
export function resetEnvCache(): void {
  cached = null;
}

/**
 * Non-throwing configuration summary, safe to render in the UI.
 *
 * Deliberately returns booleans rather than values — this is what lets the UI show
 * an honest "Mind not connected" state without ever risking secret exposure.
 */
export function describeEnv(source: NodeJS.ProcessEnv = process.env): {
  mindsConfigured: boolean;
  collaboratorConfigured: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  if (!source.MINDS_BUILDER_API_KEY?.trim()) missing.push("MINDS_BUILDER_API_KEY");
  if (!source.MINDS_MIND_ID?.trim()) missing.push("MINDS_MIND_ID");
  if (!source.COLLABORATOR_TEST_EMAIL?.trim()) missing.push("COLLABORATOR_TEST_EMAIL");

  return {
    mindsConfigured: !missing.includes("MINDS_BUILDER_API_KEY") && !missing.includes("MINDS_MIND_ID"),
    collaboratorConfigured: !missing.includes("COLLABORATOR_TEST_EMAIL"),
    missing,
  };
}
