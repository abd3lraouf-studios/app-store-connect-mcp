/**
 * Verifying Apple's signatures, not merely decoding them.
 *
 * Every meaningful App Store Server API payload arrives as a compact JWS whose
 * x5c chain roots in Apple Root CA - G3. Decoding one tells you what the bytes
 * say; verifying it tells you Apple said it. The difference matters here more
 * than in most places, because these payloads are the evidence behind
 * entitlement decisions — "is this person a paying subscriber?" — and a decoded
 * but unverified transaction is exactly the shape a forged one takes.
 *
 * Verification is delegated to Apple's own library rather than hand-rolled.
 * Chain validation, expiry, revocation and the environment/bundle checks are
 * all places where a plausible-looking implementation passes bad input, and
 * Apple's is the reference.
 *
 * Where it cannot run — no bundle ID configured, or Production without an app
 * Apple ID — payloads are still decoded, and every field says plainly that it
 * was not verified. Silence there would be the dangerous outcome.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignedDataVerifier, Environment, VerificationException } from '@apple/app-store-server-library';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_CA = path.join(HERE, '..', 'certs', 'AppleRootCA-G3.cer');

export type VerificationOutcome =
  | { verified: true }
  | { verified: false; reason: string; recoverable: boolean };

export interface JwsOptions {
  environment: 'Production' | 'Sandbox';
  bundleId?: string;
  appAppleId?: number;
  /** OCSP revocation checks. Correct, but adds a network round trip. */
  onlineChecks?: boolean;
  /**
   * Trust anchors, for tests only.
   *
   * Substituting the root is how the accept path can be exercised without a
   * real Apple-signed payload. The server never sets this — there is
   * deliberately no flag or environment variable for it, because a
   * configurable trust anchor is the same thing as no trust anchor.
   */
  rootCertificates?: Buffer[];
}

/** Which verifier method applies to which field name. */
type Kind = 'transaction' | 'renewal' | 'notification' | 'appTransaction';

const FIELD_KINDS: Record<string, Kind> = {
  signedTransactionInfo: 'transaction',
  signedTransactions: 'transaction',
  signedRenewalInfo: 'renewal',
  signedPayload: 'notification',
  signedAppTransactionInfo: 'appTransaction',
  signedAppTransaction: 'appTransaction',
};

export class JwsVerifier {
  private verifier?: SignedDataVerifier;
  /** Why verification is unavailable, when it is. */
  readonly unavailable?: string;

  constructor(options: JwsOptions) {
    const roots = options.rootCertificates;
    if (!roots && !fs.existsSync(ROOT_CA)) {
      this.unavailable = `Apple Root CA is missing at ${ROOT_CA}. Run: npm run fetch:specs`;
      return;
    }
    if (!options.bundleId) {
      this.unavailable = 'No bundle ID configured (ASC_BUNDLE_ID), which Apple requires to verify a signature.';
      return;
    }
    // Apple's verifier requires the numeric app Apple ID in Production; it
    // binds the payload to a specific app, and skipping it would accept a
    // correctly-signed transaction belonging to somebody else's app.
    if (options.environment === 'Production' && options.appAppleId === undefined) {
      this.unavailable =
        'No app Apple ID configured (ASC_APP_APPLE_ID), which Apple requires to verify Production signatures. ' +
        'Without it a correctly signed payload from a different app would pass.';
      return;
    }

    try {
      this.verifier = new SignedDataVerifier(
        roots ?? [fs.readFileSync(ROOT_CA)],
        options.onlineChecks ?? true,
        options.environment === 'Sandbox' ? Environment.SANDBOX : Environment.PRODUCTION,
        options.bundleId,
        options.appAppleId
      );
    } catch (error) {
      this.unavailable = `Could not build the verifier: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  get available(): boolean {
    return this.verifier !== undefined;
  }

  async verify(jws: string, kind: Kind): Promise<{ payload: unknown; outcome: VerificationOutcome }> {
    if (!this.verifier) {
      return {
        payload: decodeWithoutVerifying(jws),
        outcome: { verified: false, reason: this.unavailable ?? 'Verification is not configured.', recoverable: true },
      };
    }

    try {
      const payload = await this.run(this.verifier, jws, kind);
      return { payload, outcome: { verified: true } };
    } catch (error) {
      // A verification failure is a finding, not a crash: return the decoded
      // payload so the caller can see what was claimed, clearly marked as
      // unverified rather than quietly dropped.
      const status = error instanceof VerificationException ? error.status : undefined;
      const reason =
        error instanceof VerificationException
          ? `Apple's verifier rejected this payload (${statusName(status)}).`
          : `Verification failed: ${error instanceof Error ? error.message : String(error)}`;
      return {
        payload: decodeWithoutVerifying(jws),
        // Only a retryable status is worth trying again; the rest are real.
        outcome: { verified: false, reason, recoverable: statusName(status) === 'RETRYABLE_VERIFICATION_FAILURE' },
      };
    }
  }

  private run(verifier: SignedDataVerifier, jws: string, kind: Kind): Promise<unknown> {
    switch (kind) {
      case 'transaction':
        return verifier.verifyAndDecodeTransaction(jws);
      case 'renewal':
        return verifier.verifyAndDecodeRenewalInfo(jws);
      case 'notification':
        return verifier.verifyAndDecodeNotification(jws);
      case 'appTransaction':
        return verifier.verifyAndDecodeAppTransaction(jws);
    }
  }
}

function statusName(status: unknown): string {
  const names: Record<number, string> = {
    0: 'OK',
    1: 'VERIFICATION_FAILURE',
    2: 'RETRYABLE_VERIFICATION_FAILURE',
    3: 'INVALID_APP_IDENTIFIER',
    4: 'INVALID_ENVIRONMENT',
    5: 'INVALID_CHAIN_LENGTH',
    6: 'INVALID_CERTIFICATE',
    7: 'FAILURE',
  };
  return typeof status === 'number' ? (names[status] ?? `status ${status}`) : 'unknown status';
}

/** Last resort: read the claims without any assurance they are Apple's. */
export function decodeWithoutVerifying(jws: string): unknown {
  const parts = jws.split('.');
  const claims = parts[1];
  if (parts.length !== 3 || !claims) return jws;
  try {
    return JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
  } catch {
    return jws;
  }
}

function looksLikeJws(value: unknown): value is string {
  return typeof value === 'string' && value.split('.').length === 3;
}

/**
 * Walk a StoreKit response, verifying every signed field in place.
 *
 * The original JWS is preserved next to the decoded claims, and each decoded
 * value carries its own verification result — per field rather than per
 * response, because one bad signature in a history of two hundred is the case
 * that matters and a single response-level flag would hide it.
 */
export async function verifySignedFields(value: unknown, verifier: JwsVerifier): Promise<unknown> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((v) => verifySignedFields(v, verifier)));
  }
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const kind = FIELD_KINDS[key];

    if (kind && looksLikeJws(v)) {
      out[key] = v;
      const { payload, outcome } = await verifier.verify(v, kind);
      out[`${key}_decoded`] = payload;
      out[`${key}_verification`] = outcome;
      continue;
    }

    if (kind && Array.isArray(v) && v.every(looksLikeJws)) {
      out[key] = v;
      const results = await Promise.all((v).map((jws) => verifier.verify(jws, kind)));
      out[`${key}_decoded`] = results.map((r) => r.payload);
      const failures = results.filter((r) => !r.outcome.verified);
      out[`${key}_verification`] = failures.length
        ? {
            verified: false,
            reason: `${failures.length} of ${results.length} signatures did not verify.`,
            perItem: results.map((r) => r.outcome),
          }
        : { verified: true, count: results.length };
      continue;
    }

    out[key] = await verifySignedFields(v, verifier);
  }
  return out;
}
