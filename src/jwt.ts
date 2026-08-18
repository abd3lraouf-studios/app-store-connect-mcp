/**
 * Token minting for Apple's two APIs.
 *
 * Both are ES256 and share an issuer and key, but they are not interchangeable:
 * the App Store Server API (StoreKit 2) additionally requires a `bid` claim
 * naming the app's bundle ID, and rejects a token without it. Minting them
 * through one function with a flag keeps that difference in a single place.
 *
 * Apple caps token lifetime at 20 minutes and rejects anything longer, so
 * tokens are minted for 19 and cached until a minute before expiry.
 */
import jwt from 'jsonwebtoken';
import type { Credentials } from './credentials.js';

const LIFETIME_SECONDS = 19 * 60;
const REFRESH_MARGIN_SECONDS = 60;

export type Audience = 'connect' | 'storekit';

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class TokenMinter {
  private cache = new Map<string, CachedToken>();

  constructor(
    private readonly creds: Credentials,
    private readonly bundleId?: string
  ) {}

  /**
   * @param audience `storekit` adds the `bid` claim the Server API requires.
   */
  mint(audience: Audience = 'connect'): string {
    const cacheKey = audience;
    const now = Math.floor(Date.now() / 1000);

    const hit = this.cache.get(cacheKey);
    if (hit && hit.expiresAt - REFRESH_MARGIN_SECONDS > now) return hit.token;

    if (audience === 'storekit' && !this.bundleId) {
      throw new Error(
        'The App Store Server API requires a bundle ID. Set ASC_BUNDLE_ID (or --bundle-id).'
      );
    }

    const expiresAt = now + LIFETIME_SECONDS;
    const payload: Record<string, unknown> = {
      iss: this.creds.issuerId,
      iat: now,
      exp: expiresAt,
      aud: 'appstoreconnect-v1',
    };
    if (audience === 'storekit') payload.bid = this.bundleId;

    const token = jwt.sign(payload, this.creds.privateKey, {
      algorithm: 'ES256',
      header: { alg: 'ES256', kid: this.creds.keyId, typ: 'JWT' },
    });

    this.cache.set(cacheKey, { token, expiresAt });
    return token;
  }

  /** Drop cached tokens; used when a 401 suggests the cached one went stale. */
  invalidate(): void {
    this.cache.clear();
  }
}

/**
 * Decode a JWS payload without verifying it.
 *
 * App Store Server API responses wrap their data in JWS signed by Apple.
 * Verifying the chain needs Apple's root certificates; this only decodes, so
 * results are labelled unverified wherever they are returned. That is
 * acceptable because the transport is TLS to Apple's own host — but it is not
 * a substitute for signature verification if you forward these values on.
 */
export function decodeJwsPayload(jws: string): unknown {
  const parts = jws.split('.');
  const claims = parts[1];
  if (parts.length !== 3 || !claims) return jws;
  try {
    return JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
  } catch {
    return jws;
  }
}
