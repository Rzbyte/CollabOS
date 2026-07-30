/**
 * Reliability computation.
 *
 * This number feeds directly into future partner recommendations, so the formula is pinned
 * by tests. It is derived from two facts CollabOS genuinely observed — timeliness and whether
 * the automated reminder was needed — and is never an audience or engagement measurement.
 */
import { describe, expect, it } from "vitest";

import { computeReliability } from "../../src/lib/campaign/completion.ts";

describe("computeReliability — first collaboration (no prior score)", () => {
  it("rewards on-time delivery with no reminder most highly", () => {
    expect(
      computeReliability({ prior: null, submittedOnTime: true, neededFollowUp: false }),
    ).toBe(1);
  });

  it("discounts on-time delivery that needed a reminder", () => {
    expect(
      computeReliability({ prior: null, submittedOnTime: true, neededFollowUp: true }),
    ).toBe(0.8);
  });

  it("penalises late delivery that also needed chasing most heavily", () => {
    expect(
      computeReliability({ prior: null, submittedOnTime: false, neededFollowUp: true }),
    ).toBe(0.45);
  });

  it("treats late-but-unprompted as better than late-and-chased", () => {
    const unprompted = computeReliability({
      prior: null,
      submittedOnTime: false,
      neededFollowUp: false,
    });
    const chased = computeReliability({
      prior: null,
      submittedOnTime: false,
      neededFollowUp: true,
    });

    expect(unprompted).toBe(0.65);
    expect(unprompted).toBeGreaterThan(chased);
  });

  it("ranks all four outcomes in a sensible order", () => {
    const best = computeReliability({ prior: null, submittedOnTime: true, neededFollowUp: false });
    const good = computeReliability({ prior: null, submittedOnTime: true, neededFollowUp: true });
    const poor = computeReliability({ prior: null, submittedOnTime: false, neededFollowUp: false });
    const worst = computeReliability({ prior: null, submittedOnTime: false, neededFollowUp: true });

    expect(best).toBeGreaterThan(good);
    expect(good).toBeGreaterThan(poor);
    expect(poor).toBeGreaterThan(worst);
  });
});

describe("computeReliability — blending with history", () => {
  it("weights history 60% and the new collaboration 40%", () => {
    // 0.5 * 0.6 + 1.0 * 0.4 = 0.7
    expect(
      computeReliability({ prior: 0.5, submittedOnTime: true, neededFollowUp: false }),
    ).toBe(0.7);
  });

  it("does not let one collaboration erase a strong history", () => {
    // Mira's seeded 0.95 with a late, chased delivery: 0.95*0.6 + 0.45*0.4 = 0.75
    const updated = computeReliability({
      prior: 0.95,
      submittedOnTime: false,
      neededFollowUp: true,
    });

    expect(updated).toBe(0.75);
    expect(updated).toBeGreaterThan(0.45); // better than the observation alone
    expect(updated).toBeLessThan(0.95); // but the history is genuinely dented
  });

  it("does not let one good collaboration fully rehabilitate a weak history", () => {
    // Alex's seeded 0.55 with a perfect delivery: 0.55*0.6 + 1.0*0.4 = 0.73
    const updated = computeReliability({
      prior: 0.55,
      submittedOnTime: true,
      neededFollowUp: false,
    });

    expect(updated).toBe(0.73);
    expect(updated).toBeGreaterThan(0.55);
    expect(updated).toBeLessThan(1);
  });

  it("keeps a perfect record perfect when delivery stays perfect", () => {
    expect(
      computeReliability({ prior: 1, submittedOnTime: true, neededFollowUp: false }),
    ).toBe(1);
  });

  it("always stays within 0..1", () => {
    const priors = [null, 0, 0.25, 0.5, 0.75, 1];
    for (const prior of priors) {
      for (const onTime of [true, false]) {
        for (const followUp of [true, false]) {
          const value = computeReliability({
            prior,
            submittedOnTime: onTime,
            neededFollowUp: followUp,
          });
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("rounds to two decimals so stored scores stay readable", () => {
    const value = computeReliability({
      prior: 0.333,
      submittedOnTime: true,
      neededFollowUp: true,
    });
    expect(value).toBe(Number(value.toFixed(2)));
  });
});
