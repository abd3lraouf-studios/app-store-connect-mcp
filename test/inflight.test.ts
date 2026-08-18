/**
 * Shutdown must not eat a reply.
 *
 * This is the logic behind a bug only live testing found: stdin EOF fired the
 * shutdown while a multi-second macro was still running, and the response was
 * never written. Fast calls hid it — every earlier stdio test passed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { begin, end, activeCount, whenIdle } from '../src/inflight.js';

beforeEach(() => {
  while (activeCount() > 0) end();
});

describe('tracking', () => {
  it('counts up and down', () => {
    begin();
    begin();
    expect(activeCount()).toBe(2);
    end();
    expect(activeCount()).toBe(1);
  });

  it('never goes negative, so a stray end cannot unblock a real wait', () => {
    end();
    end();
    expect(activeCount()).toBe(0);
  });
});

describe('whenIdle', () => {
  it('resolves immediately when nothing is running', async () => {
    const started = Date.now();
    await whenIdle(5_000);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('waits for the in-flight request, then resolves', async () => {
    begin();
    let settled = false;
    const waiting = whenIdle(5_000).then(() => (settled = true));

    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false); // still working — must not exit yet

    end();
    await waiting;
    expect(settled).toBe(true);
  });

  it('waits for the last of several', async () => {
    begin();
    begin();
    let settled = false;
    const waiting = whenIdle(5_000).then(() => (settled = true));

    end();
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);

    end();
    await waiting;
    expect(settled).toBe(true);
  });

  // A hung request must not keep the process alive forever.
  it('gives up at the deadline', async () => {
    begin();
    const started = Date.now();
    await whenIdle(50);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    end();
  });
});
