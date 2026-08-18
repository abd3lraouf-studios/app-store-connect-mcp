/**
 * In-flight request tracking, so shutdown does not eat a reply.
 *
 * On stdio, EOF means "no further requests are coming" — it does not mean
 * "abandon the ones you are already answering". Exiting immediately on EOF
 * loses the response to anything still running, which shows up as a client
 * that asked a slow question and got silence. Any batched or piped input hits
 * this, because the pipe drains long before the work finishes.
 */
let active = 0;
const idleWaiters: Array<() => void> = [];

export function begin(): void {
  active += 1;
}

export function end(): void {
  active = Math.max(0, active - 1);
  if (active === 0) {
    while (idleWaiters.length) idleWaiters.pop()?.();
  }
}

export function activeCount(): number {
  return active;
}

/** Resolve once nothing is in flight, or when the deadline passes. */
export function whenIdle(timeoutMs: number): Promise<void> {
  if (active === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    idleWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
