/**
 * The one critical end-to-end flow (CLAUDE.md §20).
 *
 * Drives the entire vertical slice through the real UI in a real browser against a real
 * Postgres and a real SMTP sink:
 *
 *   submit objective → review candidates → approve Mira → approve first outreach
 *   → accept as collaborator → show Circle state → worker fires the autonomous follow-up
 *   → submit deliverable → approve deliverable → campaign completes
 *
 * Two things are NOT real here, both loudly labelled: the Mind is the offline fixture port
 * (no API key exists in this environment), and email goes to Mailpit. Everything else — the
 * state machine, approval gates, audit log, signed links, worker claiming — is the production
 * code path.
 *
 * The autonomous follow-up is triggered by running the actual worker process via
 * `npm run worker:once`, NOT by clicking anything. That is the point of the test.
 */
import { execFileSync } from "node:child_process";

import { expect, test, type Page } from "@playwright/test";

const OBJECTIVE =
  "Launch a wallet-safety educational video and grow my beginner audience through one collaboration.";

/**
 * Runs the real worker process, exactly as an operator would.
 *
 * The worker is genuinely a separate process with its own environment, so the fixture-Mind
 * flag has to be passed explicitly — the web server's copy does not reach it. That
 * separation is the whole point of the autonomy claim, and this is a small reminder of it.
 */
function runWorkerOnce(): string {
  return execFileSync("npm", ["run", "worker:once"], {
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      FOLLOW_UP_DELAY_SECONDS: "5",
      COLLABOS_UNSAFE_FIXTURE_MIND: "1",
    },
  });
}

/** Resets campaign state and restores seeded relationship memory. */
function resetDemo(): void {
  execFileSync("npm", ["run", "demo:reset"], { encoding: "utf8", timeout: 120_000 });
}

async function gotoAndWait(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole("heading", { name: "CollabOS" }).first()).toBeVisible();
}

test.beforeAll(() => {
  resetDemo();
});

test.afterAll(() => {
  resetDemo();
});

test("runs one collaboration from objective to completed campaign", async ({ page }) => {
  // The fixture-Mind warning must be visible throughout — if this banner ever disappears
  // while canned data is in use, the UI has become dishonest.
  await gotoAndWait(page, "/");
  await expect(page.getByRole("alert").filter({ hasText: "OFFLINE FIXTURE MIND" })).toBeVisible();

  // ---------------------------------------------------------------- 1. objective
  await test.step("submit the growth objective", async () => {
    const objective = page.getByLabel("Growth objective");
    await expect(objective).toBeVisible();
    await objective.fill(OBJECTIVE);
    await page.getByRole("button", { name: /submit objective/i }).click();

    // Asserting DURABLE state, not the success toast. Server-action feedback lives inside
    // the form component, which unmounts the moment revalidation replaces it with the
    // active-campaign panel — so the toast is gone by the time the page settles. The
    // resulting state is the real evidence anyway.
    await expect(page.getByRole("link", { name: /review candidates/i })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText("Partners recommended").first()).toBeVisible();
  });

  // ------------------------------------------------------- 2. review candidates
  await test.step("review the ranked candidates", async () => {
    await gotoAndWait(page, "/partners");

    // All three seeded candidates appear.
    await expect(page.getByRole("heading", { name: "Mira Chen" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Alex Morgan" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Nova Alpha" })).toBeVisible();

    // Mira is ranked first despite having the SMALLEST audience.
    const cards = page.locator("article");
    await expect(cards.first().getByRole("heading", { name: "Mira Chen" })).toBeVisible();

    // Memory is shown as evidence, not decoration.
    await expect(page.getByText(/memory used in this decision/i).first()).toBeVisible();

    // Nova is blocked on brand safety and cannot be approved at all.
    await expect(page.getByText(/blocked by brand-safety boundary/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /approve blocked/i })).toBeDisabled();
  });

  // ----------------------------------------------------------- 3. approve Mira
  await test.step("approve Mira", async () => {
    await page.getByRole("button", { name: /approve mira chen/i }).click();

    // Durable evidence: the campaign has moved to the outreach gate.
    await expect(page.getByText("Outreach approval required").first()).toBeVisible({
      timeout: 60_000,
    });
  });

  // ------------------------------------------------- 4. approve first outreach
  await test.step("approve the first outreach separately", async () => {
    await gotoAndWait(page, "/room");

    // Approving a partner must NOT have authorised contact — a second gate is required.
    await expect(page.getByText(/your approval is required before any contact/i)).toBeVisible();

    await page.getByRole("button", { name: /approve and send outreach/i }).click();

    // Durable evidence: state advanced and the message was recorded with its transport.
    await expect(page.getByText("Outreach sent").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/local test transport/i).first()).toBeVisible();
  });

  // -------------------------------------------------- 5. accept as collaborator
  const collabUrl = await test.step("open the signed collaborator link", async () => {
    await gotoAndWait(page, "/room");

    const link = await page
      .locator("code")
      .filter({ hasText: "/collab/" })
      .first()
      .innerText();

    expect(link).toContain("/collab/");
    return link.trim();
  });

  await test.step("accept the collaboration", async () => {
    await page.goto(collabUrl);

    // The collaborator view must not leak the creator's private strategy data.
    await expect(page.getByText("Collaborator view")).toBeVisible();
    await expect(page.getByText(/leverage trading/i)).toHaveCount(0);
    await expect(page.getByText("Alex Morgan")).toHaveCount(0);
    await expect(page.getByText("Nova Alpha")).toHaveCount(0);

    await page.getByRole("button", { name: /accept collaboration/i }).click();

    // Durable evidence: the shared brief now exists and is visible to the collaborator.
    await expect(page.getByRole("heading", { name: /shared brief/i })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole("heading", { name: /your deliverable/i })).toBeVisible();
  });

  // ------------------------------------------------------- 6. show Circle state
  await test.step("show the Circle membership state", async () => {
    await gotoAndWait(page, "/room");

    await expect(page.getByRole("heading", { name: /mind circle/i })).toBeVisible();
    await expect(page.getByText(/platform membership/i)).toBeVisible();
    // The shared brief is authored once the partner accepts.
    await expect(page.getByRole("heading", { name: /wallet safety basics/i })).toBeVisible();
  });

  // -------------------------------------- 7. autonomous follow-up (no button!)
  await test.step("the worker sends the follow-up with no user interaction", async () => {
    // The configured deadline is 5s; wait for it to pass, then run the REAL worker process.
    await page.waitForTimeout(6_500);

    const output = runWorkerOnce();
    expect(output).toMatch(/claimed 1 campaign/);
    expect(output).toMatch(/sent/);

    await gotoAndWait(page, "/activity");

    // Each action appears once per recorded lifecycle phase, so this text legitimately
    // resolves to several elements (proposed / attempted / succeeded). That multiplicity IS
    // the §3 "verifiable execution" requirement — assert at least one and count them below.
    const generating = page.getByText(/autonomous follow-up generation started/i);
    await expect(generating.first()).toBeVisible();
    expect(await generating.count()).toBeGreaterThan(1);

    await expect(page.getByText(/follow-up sent through/i).first()).toBeVisible();

    // Marked autonomous, and delivered through a clearly labelled test transport.
    await expect(page.getByText("Autonomous").first()).toBeVisible();
    await expect(page.getByText(/local test transport/i).first()).toBeVisible();
  });

  // ------------------------------------------------- 8. submit the deliverable
  await test.step("submit the deliverable as the collaborator", async () => {
    await page.goto(collabUrl);

    await page
      .getByLabel(/link to your deliverable/i)
      .fill("https://example.com/mira-wallet-safety-segment");
    await page.getByLabel(/note for the creator/i).fill("Recorded the seed-phrase demo.");
    await page.getByRole("button", { name: /submit deliverable/i }).click();

    // Durable evidence on the collaborator page.
    await expect(page.getByText(/submitted — thank you/i)).toBeVisible({ timeout: 60_000 });
  });

  // ------------------------------------------------ 9. final approval + complete
  await test.step("approve the deliverable and complete the campaign", async () => {
    await gotoAndWait(page, "/room");

    await expect(page.getByText(/your final approval is required/i)).toBeVisible();
    await page.getByLabel(/your rating of this collaboration/i).fill("0.9");
    await page.getByRole("button", { name: /approve and complete/i }).click();

    // Durable evidence: the campaign is terminal and links to its report.
    await expect(page.getByText("Campaign completed").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("link", { name: /view the campaign report/i })).toBeVisible();
  });

  // --------------------------------------------------------- 10. the report
  await test.step("the report shows the outcome and its own limitations", async () => {
    await gotoAndWait(page, "/report");

    await expect(page.getByRole("heading", { name: /campaign report/i })).toBeVisible();
    await expect(page.getByText(/why this partner/i)).toBeVisible();
    await expect(page.getByText(/relationship memory after this campaign/i)).toBeVisible();

    // Mira now has two collaborations recorded.
    await expect(page.getByText(/2 collaborations/i).first()).toBeVisible();

    // The honesty disclosure must be present.
    await expect(page.getByText(/what this report does not claim/i)).toBeVisible();
    await expect(page.getByText(/no audience growth is measured/i)).toBeVisible();
  });
});

test("refuses an invalid collaborator link", async ({ page }) => {
  await page.goto("/collab/not-a-real-token");
  await expect(page.getByText(/link not valid/i)).toBeVisible();
});
