import { describe, it, expect } from 'vitest';
import { decodeSignedFields, STOREKIT_OPERATIONS, STOREKIT_BY_ID, STOREKIT_HOSTS } from '../src/storekit.js';

const decode = (s: string) => ({ decoded: s.toUpperCase() });

describe('catalogue', () => {
  it('uses the current hosts, not the retired itunes ones', () => {
    expect(STOREKIT_HOSTS.Production).toBe('https://api.storekit.apple.com');
    expect(STOREKIT_HOSTS.Sandbox).toBe('https://api.storekit-sandbox.apple.com');
    for (const h of Object.values(STOREKIT_HOSTS)) expect(h).not.toContain('itunes');
  });

  // Apple's own client orders these segments productId-then-requestIdentifier,
  // which is the reverse of what the docs imply.
  it('orders the mass-extension status path as Apple does', () => {
    const op = STOREKIT_BY_ID.get('storekit_getStatusOfSubscriptionRenewalDateExtensions');
    expect(op?.path).toBe('/inApps/v1/subscriptions/extend/mass/{productId}/{requestIdentifier}');
  });

  it('declares every path parameter that appears in its template', () => {
    for (const op of STOREKIT_OPERATIONS) {
      const inTemplate = [...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      expect(new Set(op.pathParams)).toEqual(new Set(inTemplate));
    }
  });

  it('has unique ids', () => {
    expect(new Set(STOREKIT_OPERATIONS.map((o) => o.id)).size).toBe(STOREKIT_OPERATIONS.length);
  });

  it('marks the mass renewal extension as revenue-affecting', () => {
    expect(STOREKIT_BY_ID.get('storekit_extendRenewalDateForAllActiveSubscribers')?.risk).toBe('REVENUE');
  });
});

describe('decodeSignedFields', () => {
  it('decodes a signed scalar and keeps the original', () => {
    const out = decodeSignedFields({ signedTransactionInfo: 'a.b.c' }, decode) as any;
    expect(out.signedTransactionInfo).toBe('a.b.c');
    expect(out.signedTransactionInfo_decoded).toEqual({ decoded: 'A.B.C' });
  });

  it('decodes arrays of signed values', () => {
    const out = decodeSignedFields({ signedTransactions: ['a.b.c', 'd.e.f'] }, decode) as any;
    expect(out.signedTransactions_decoded).toHaveLength(2);
  });

  it('walks nested objects and arrays', () => {
    const out = decodeSignedFields(
      { data: [{ lastTransactions: [{ signedRenewalInfo: 'x.y.z' }] }] },
      decode
    ) as any;
    expect(out.data[0].lastTransactions[0].signedRenewalInfo_decoded).toEqual({ decoded: 'X.Y.Z' });
  });

  it('leaves a signed-prefixed field alone when it is not a JWS', () => {
    const out = decodeSignedFields({ signedDate: 1699999999 }, decode) as any;
    expect(out.signedDate).toBe(1699999999);
    expect(out.signedDate_decoded).toBeUndefined();
  });

  it('does not touch unrelated fields', () => {
    const out = decodeSignedFields({ bundleId: 'com.x', revision: 'r1' }, decode) as any;
    expect(out).toEqual({ bundleId: 'com.x', revision: 'r1' });
  });

  it('passes primitives through', () => {
    expect(decodeSignedFields(null, decode)).toBeNull();
    expect(decodeSignedFields('plain', decode)).toBe('plain');
  });
});
