/**
 * Injectable clock.
 *
 * Every deadline, lease expiry, and `nextActionAt` comparison reads time through
 * this seam. That is what allows the test suite to prove the autonomous follow-up
 * fires when a deliverable is overdue WITHOUT waiting three real minutes — the test
 * advances a controlled clock instead.
 *
 * Production code must never call `new Date()` or `Date.now()` for scheduling
 * decisions; it calls `clock.now()`.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/**
 * Manually advanced clock for tests.
 *
 * @example
 * const clock = new FixedClock(new Date("2026-01-01T09:00:00Z"));
 * clock.advanceSeconds(181); // deliverable is now overdue
 */
export class FixedClock implements Clock {
  private current: Date;

  constructor(start: Date = new Date("2026-01-01T09:00:00.000Z")) {
    this.current = new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(next: Date): void {
    this.current = new Date(next.getTime());
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  advanceSeconds(seconds: number): void {
    this.advanceMs(seconds * 1000);
  }
}

let ambient: Clock = systemClock;

export function getClock(): Clock {
  return ambient;
}

/** Test seam. Always restore `systemClock` in cleanup. */
export function setClock(clock: Clock): void {
  ambient = clock;
}

export function resetClock(): void {
  ambient = systemClock;
}
