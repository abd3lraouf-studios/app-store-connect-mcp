import { describe, it, expect } from 'vitest';
import { STOREKIT_OPERATIONS, STOREKIT_BY_ID, STOREKIT_HOSTS } from '../src/storekit.js';

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
