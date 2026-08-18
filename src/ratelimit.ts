/**
 * Proactive pacing against Apple's rate limits.
 *
 * Apple documents 3,600 requests/hour. It does not document a per-minute
 * ceiling, but one exists, so both windows are paced rather than waiting for a
 * 429 and reacting. Reacting is worse than it sounds: by the time Apple
 * refuses you, an agent mid-way through a bulk read has already lost its place.
 *
 * Every response carries the real budget back:
 *
 *   x-rate-limit: user-hour-lim:3600;user-hour-rem:3599;
 *
 * so local accounting is corrected from Apple's own numbers instead of drifting.
 * This matters when several agents share one team key — each would otherwise
 * pace as though it were the only client.
 */

export interface RateLimitState {
  hourLimit?: number;
  hourRemaining?: number;
  /** Requests this limiter has issued in the trailing hour. */
  issuedThisHour: number;
  issuedThisMinute: number;
}

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** Undocumented, but a real ceiling. Stay well under it. */
const DEFAULT_PER_MINUTE = 300;
const DEFAULT_PER_HOUR = 3600;

/** Stop short of the wall so a human at a terminal is never locked out. */
const RESERVE = 50;

export class RateLimiter {
  private hourStamps: number[] = [];
  private minuteStamps: number[] = [];
  private appleHourLimit?: number;
  private appleHourRemaining?: number;
  /** When the figure above was reported. It goes stale after an hour. */
  private appleObservedAt?: number;

  constructor(
    private readonly perHour = DEFAULT_PER_HOUR,
    private readonly perMinute = DEFAULT_PER_MINUTE,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms))
  ) {}

  private prune(): void {
    const t = this.now();
    this.hourStamps = this.hourStamps.filter((s) => t - s < HOUR_MS);
    this.minuteStamps = this.minuteStamps.filter((s) => t - s < MINUTE_MS);

    // Apple's figure describes a rolling hour. Once that hour has passed it
    // tells us nothing, and continuing to honour it would park the limiter
    // forever waiting for a number that only a fresh response can update.
    if (this.appleObservedAt !== undefined && t - this.appleObservedAt >= HOUR_MS) {
      this.appleHourRemaining = undefined;
      this.appleObservedAt = undefined;
    }
  }

  /**
   * Wait until a request may be issued, then record it.
   *
   * Admission is recorded before the request is sent rather than after it
   * returns, so concurrent callers cannot both observe a window with one slot
   * left and both take it.
   */
  async acquire(): Promise<void> {
    for (;;) {
      this.prune();
      const t = this.now();

      // Apple's own count wins when we have it: it accounts for other clients
      // sharing this key, which local counting cannot see.
      if (this.appleHourRemaining !== undefined && this.appleHourRemaining <= RESERVE) {
        const oldest = this.hourStamps[0] ?? t;
        const waitMs = Math.max(1000, HOUR_MS - (t - oldest));
        await this.sleep(waitMs);
        continue;
      }

      if (this.minuteStamps.length >= this.perMinute) {
        const oldest = this.minuteStamps[0] as number;
        await this.sleep(Math.max(50, MINUTE_MS - (t - oldest)));
        continue;
      }

      if (this.hourStamps.length >= this.perHour) {
        const oldest = this.hourStamps[0] as number;
        await this.sleep(Math.max(1000, HOUR_MS - (t - oldest)));
        continue;
      }

      this.hourStamps.push(t);
      this.minuteStamps.push(t);
      if (this.appleHourRemaining !== undefined) this.appleHourRemaining -= 1;
      return;
    }
  }

  /**
   * Fold Apple's reported budget back into local accounting.
   * Header format: `user-hour-lim:3600;user-hour-rem:3599;`
   */
  observeHeader(value: string | null | undefined): void {
    if (!value) return;
    const lim = /user-hour-lim:(\d+)/.exec(value);
    const rem = /user-hour-rem:(\d+)/.exec(value);
    if (lim) this.appleHourLimit = Number(lim[1]);
    if (rem) {
      this.appleHourRemaining = Number(rem[1]);
      this.appleObservedAt = this.now();
    }
  }

  get state(): RateLimitState {
    this.prune();
    return {
      hourLimit: this.appleHourLimit,
      hourRemaining: this.appleHourRemaining,
      issuedThisHour: this.hourStamps.length,
      issuedThisMinute: this.minuteStamps.length,
    };
  }
}
