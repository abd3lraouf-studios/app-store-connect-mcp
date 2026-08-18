/**
 * Time and sleeping are both injected, so these run instantly and
 * deterministically rather than actually waiting out a window.
 */
import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../src/ratelimit.js';

/** A limiter on a virtual clock: sleeping advances time instead of blocking. */
function harness(perHour: number, perMinute: number) {
  let now = 1_000_000;
  const sleeps: number[] = [];
  const limiter = new RateLimiter(
    perHour,
    perMinute,
    () => now,
    async (ms) => {
      sleeps.push(ms);
      now += ms;
    }
  );
  return { limiter, sleeps, advance: (ms: number) => (now += ms), nowRef: () => now };
}

describe('pacing', () => {
  it('admits freely below both ceilings', async () => {
    const { limiter, sleeps } = harness(3600, 300);
    for (let i = 0; i < 10; i++) await limiter.acquire();
    expect(sleeps).toHaveLength(0);
    expect(limiter.state.issuedThisMinute).toBe(10);
  });

  it('waits at the per-minute ceiling', async () => {
    const { limiter, sleeps } = harness(3600, 3);
    for (let i = 0; i < 4; i++) await limiter.acquire();
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it('lets the minute window drain and then admits again', async () => {
    const { limiter, sleeps, advance } = harness(3600, 2);
    await limiter.acquire();
    await limiter.acquire();
    advance(61_000);
    await limiter.acquire();
    expect(sleeps).toHaveLength(0);
    expect(limiter.state.issuedThisMinute).toBe(1);
  });

  it('waits at the hourly ceiling', async () => {
    const { limiter, sleeps } = harness(2, 300);
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(sleeps.some((s) => s >= 1000)).toBe(true);
  });
});

describe('observeHeader', () => {
  it('parses Apple’s rate-limit header', () => {
    const { limiter } = harness(3600, 300);
    limiter.observeHeader('user-hour-lim:3600;user-hour-rem:3421;');
    expect(limiter.state.hourLimit).toBe(3600);
    expect(limiter.state.hourRemaining).toBe(3421);
  });

  it('ignores a missing or unparseable header rather than throwing', () => {
    const { limiter } = harness(3600, 300);
    expect(() => limiter.observeHeader(null)).not.toThrow();
    expect(() => limiter.observeHeader('nonsense')).not.toThrow();
    expect(limiter.state.hourLimit).toBeUndefined();
  });

  // Apple's number accounts for other clients sharing the same team key, which
  // local counting cannot see. It has to win.
  it('backs off when Apple reports the budget nearly spent, despite a quiet local count', async () => {
    const { limiter, sleeps } = harness(3600, 300);
    limiter.observeHeader('user-hour-lim:3600;user-hour-rem:3;');
    await limiter.acquire();
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it('decrements its view of the remaining budget as it issues', async () => {
    const { limiter } = harness(3600, 300);
    limiter.observeHeader('user-hour-lim:3600;user-hour-rem:1000;');
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.state.hourRemaining).toBe(998);
  });
});
