import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for the single critical end-to-end flow (CLAUDE.md §20).
 *
 * Two deliberate choices:
 *
 * 1. **Port 3210, not 3000.** Port 3000 is occupied by an unrelated service on the
 *    development machine, and `APP_URL` must match the server the test actually drives or the
 *    signed collaborator links point somewhere else entirely.
 *
 * 2. **`FOLLOW_UP_DELAY_SECONDS=5`.** §20 forbids making the test wait three real minutes.
 *    The unit and integration suites use an injected clock; the E2E test drives a real HTTP
 *    server in a separate process, so it shortens the configured deadline instead. Same
 *    effect, no sleeping.
 *
 * The server runs with `COLLABOS_UNSAFE_FIXTURE_MIND=1` because no Builder API key exists in
 * this environment. That flag makes every page render a red warning banner and marks every
 * stored exchange as fixture data — see `src/lib/minds/fixture-port.ts`.
 */
const PORT = 3210;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? "line" : [["list"]],

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    // Dev server rather than build + start. The fixture Mind refuses to load under
    // NODE_ENV=production by design, and forcing NODE_ENV=development onto `next build`
    // breaks the production export. `npm run build` is verified separately as its own
    // quality gate, so nothing is lost by running the E2E flow against dev.
    command: `npx next dev -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      APP_URL: BASE_URL,
      FOLLOW_UP_DELAY_SECONDS: "5",
      COLLABOS_UNSAFE_FIXTURE_MIND: "1",
    },
  },
});
