/**
 * Write gating.
 *
 * An HTTP method is a poor proxy for consequence. `PATCH /v1/subscriptionPrices`
 * and `PATCH /v1/appInfos/{id}` are both writes, but only one of them changes
 * what customers are charged, and neither is undone by issuing the same PATCH
 * again. So operations carry a risk tier, and the tiers above WRITE require a
 * second, explicit call to go through.
 *
 * The confirmation is a two-step handshake rather than a prompt because an MCP
 * server has no channel to ask a human anything: it can only answer the caller.
 * A gated call returns a preview and a token; the same call repeated with that
 * token executes. The token is bound to the exact request, so a model cannot
 * obtain one for a cheap operation and spend it on an expensive one.
 */
import { createHash, randomBytes } from 'node:crypto';

export type Risk =
  | 'READ'
  | 'WRITE'
  | 'RELEASE'
  | 'REVENUE'
  | 'INFRASTRUCTURE'
  | 'ACCESS'
  | 'DESTRUCTIVE';

export type SafetyMode = 'default' | 'confirm' | 'no-confirm' | 'read-only';

/** Tiers gated when mode is `default`. */
const GATED_BY_DEFAULT = new Set<Risk>([
  'REVENUE',
  'DESTRUCTIVE',
  'INFRASTRUCTURE',
  'ACCESS',
  'RELEASE',
]);

export const RISK_EXPLANATION: Record<Risk, string> = {
  READ: 'Reads data. No change.',
  WRITE: 'Changes data.',
  RELEASE: 'Affects what ships to customers, or a build/submission state.',
  REVENUE: 'Affects pricing, subscriptions or entitlements — what customers are charged.',
  INFRASTRUCTURE: 'Affects certificates, identifiers, devices or callback URLs.',
  ACCESS: 'Affects who can access this account, or tester membership.',
  DESTRUCTIVE: 'Deletes something. Generally not recoverable through this API.',
};

export function isWrite(risk: Risk): boolean {
  return risk !== 'READ';
}

/** A pending confirmation. Short-lived and single-use. */
interface Pending {
  fingerprint: string;
  expiresAt: number;
}

const TOKEN_TTL_MS = 5 * 60 * 1000;

export class SafetyGate {
  private pending = new Map<string, Pending>();

  constructor(private readonly mode: SafetyMode) {}

  get describeMode(): string {
    switch (this.mode) {
      case 'read-only':
        return 'read-only (every mutating operation is blocked)';
      case 'confirm':
        return 'confirm (every write requires confirmation)';
      case 'no-confirm':
        return 'no-confirm (writes execute immediately — no prompt, no token, no requiresUserInteraction flag)';
      default:
        return 'default (REVENUE, DESTRUCTIVE, INFRASTRUCTURE, ACCESS and RELEASE writes require confirmation)';
    }
  }

  /**
   * Bind a token to the specific request it was issued for, so it cannot be
   * replayed against a different one.
   */
  private fingerprint(parts: {
    operationId: string;
    method: string;
    path: string;
    query?: unknown;
    body?: unknown;
  }): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          o: parts.operationId,
          m: parts.method,
          p: parts.path,
          q: parts.query ?? null,
          b: parts.body ?? null,
        })
      )
      .digest('hex');
  }

  /**
   * @returns `null` when the call may proceed, or a message to return to the
   *   caller when it may not.
   */
  check(
    request: { operationId: string; method: string; path: string; query?: unknown; body?: unknown },
    risk: Risk,
    confirmToken?: string
  ): { blocked: true; reason: string; token?: string } | null {
    if (!isWrite(risk)) return null;

    if (this.mode === 'read-only') {
      return {
        blocked: true,
        reason:
          `Blocked: the server is running in read-only mode and ${request.operationId} is a ` +
          `${risk} operation. ${RISK_EXPLANATION[risk]} Restart without --read-only to allow it.`,
      };
    }

    const needsConfirmation =
      this.mode === 'confirm' || (this.mode === 'default' && GATED_BY_DEFAULT.has(risk));
    if (!needsConfirmation) return null;

    const fingerprint = this.fingerprint(request);

    if (confirmToken) {
      const found = this.pending.get(confirmToken);
      if (!found) {
        return { blocked: true, reason: 'Confirmation token is unknown or already used. Call again without a token to get a fresh one.' };
      }
      this.pending.delete(confirmToken);
      if (found.expiresAt < Date.now()) {
        return { blocked: true, reason: 'Confirmation token expired. Call again without a token to get a fresh one.' };
      }
      if (found.fingerprint !== fingerprint) {
        return {
          blocked: true,
          reason:
            'Confirmation token does not match this request. A token is bound to the exact ' +
            'operation, path, query and body it was issued for.',
        };
      }
      return null; // Confirmed.
    }

    const token = randomBytes(9).toString('base64url');
    this.pending.set(token, { fingerprint, expiresAt: Date.now() + TOKEN_TTL_MS });
    this.sweep();

    return {
      blocked: true,
      token,
      reason:
        `Confirmation required — ${risk}. ${RISK_EXPLANATION[risk]}\n\n` +
        `  ${request.method} ${request.path}\n` +
        (request.body ? `  body: ${JSON.stringify(request.body).slice(0, 800)}\n` : '') +
        `\nTell the user what this will change and get their agreement. To proceed, repeat ` +
        `the identical call with confirm="${token}" (valid 5 minutes, single use).`,
    };
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, p] of this.pending) if (p.expiresAt < now) this.pending.delete(token);
  }
}
