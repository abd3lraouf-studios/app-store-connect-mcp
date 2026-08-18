/**
 * The `bid` claim is the only structural difference between a Connect token
 * and a Server API token, and getting it wrong fails as an opaque 401 — so it
 * is asserted in both directions.
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { TokenMinter, decodeJwsPayload } from '../src/jwt.js';
import type { Credentials } from '../src/credentials.js';

const { privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const creds: Credentials = {
  privateKey: privateKey,
  issuerId: 'issuer-uuid',
  keyId: 'ABC123KEYD',
  source: 'test',
};

const decode = (jwt: string, part: 0 | 1) =>
  JSON.parse(Buffer.from(jwt.split('.')[part] as string, 'base64url').toString());

describe('audiences', () => {
  it('omits bid on a Connect token', () => {
    const claims = decode(new TokenMinter(creds, 'com.example.app').mint('connect'), 1);
    expect(claims.bid).toBeUndefined();
    expect(claims.aud).toBe('appstoreconnect-v1');
    expect(claims.iss).toBe('issuer-uuid');
  });

  it('includes bid on a StoreKit token', () => {
    const claims = decode(new TokenMinter(creds, 'com.example.app').mint('storekit'), 1);
    expect(claims.bid).toBe('com.example.app');
  });

  it('refuses a StoreKit token when no bundle id is configured', () => {
    expect(() => new TokenMinter(creds).mint('storekit')).toThrow(/requires a bundle ID/);
  });

  it('still mints a Connect token without a bundle id', () => {
    expect(() => new TokenMinter(creds).mint('connect')).not.toThrow();
  });
});

describe('header and lifetime', () => {
  it('signs ES256 and names the key', () => {
    const header = decode(new TokenMinter(creds).mint('connect'), 0);
    expect(header.alg).toBe('ES256');
    expect(header.kid).toBe('ABC123KEYD');
    expect(header.typ).toBe('JWT');
  });

  it('expires inside Apple’s 20-minute ceiling', () => {
    const claims = decode(new TokenMinter(creds).mint('connect'), 1);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(20 * 60);
    expect(claims.exp - claims.iat).toBeGreaterThan(10 * 60);
  });
});

describe('caching', () => {
  it('reuses a token rather than re-signing per request', () => {
    const minter = new TokenMinter(creds, 'com.example.app');
    expect(minter.mint('connect')).toBe(minter.mint('connect'));
  });

  it('keeps the two audiences in separate cache slots', () => {
    const minter = new TokenMinter(creds, 'com.example.app');
    expect(minter.mint('connect')).not.toBe(minter.mint('storekit'));
  });

  it('re-mints after invalidate, which is what a 401 retry depends on', () => {
    const minter = new TokenMinter(creds, 'com.example.app');
    const first = minter.mint('connect');
    minter.invalidate();
    const second = minter.mint('connect');
    // ES256 signatures are randomised, so a genuine re-sign produces a
    // different token even for identical claims. That difference is the proof
    // the cache was dropped rather than served again.
    expect(second).not.toBe(first);
    expect(decode(second, 1).aud).toBe(decode(first, 1).aud);
  });
});

describe('decodeJwsPayload', () => {
  it('decodes a three-part JWS', () => {
    const jws = new TokenMinter(creds).mint('connect');
    expect((decodeJwsPayload(jws) as any).aud).toBe('appstoreconnect-v1');
  });

  it('returns the input unchanged when it is not a JWS', () => {
    expect(decodeJwsPayload('not-a-jws')).toBe('not-a-jws');
  });

  it('does not throw on a three-part string that is not base64 JSON', () => {
    expect(() => decodeJwsPayload('a.b.c')).not.toThrow();
  });
});
