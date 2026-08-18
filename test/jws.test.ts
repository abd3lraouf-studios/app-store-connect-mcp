/**
 * Signature verification.
 *
 * The test that matters most is the forgery: a well-formed JWS, correctly
 * self-signed, carrying a payload that says the customer is a paying
 * subscriber. Decoding accepts it happily. Verification must not.
 *
 * Online checks are off throughout — OCSP would reach Apple, and these run
 * offline.
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createSign, X509Certificate, createPrivateKey } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JwsVerifier, decodeWithoutVerifying, verifySignedFields } from '../src/jws.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const base = { environment: 'Sandbox' as const, bundleId: 'com.example.app', onlineChecks: false };

/** A JWS that is structurally perfect and signed by nobody Apple trusts. */
function forgeJws(claims: Record<string, unknown>): string {
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  // A plausible-looking x5c chain, because that is what a real attempt has.
  const header = { alg: 'ES256', x5c: ['MIIBfake', 'MIIBfake2', 'MIIBfake3'] };
  const signingInput = `${b64(header)}.${b64(claims)}`;
  const sig = createSign('SHA256').update(signingInput).sign({ key: createPrivateKey(privateKey), dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${Buffer.from(sig).toString('base64url')}`;
}

describe('the trust anchor', () => {
  it('ships Apple Root CA - G3, so verification does not depend on the network', () => {
    const cert = new X509Certificate(fs.readFileSync(path.join(ROOT, 'certs/AppleRootCA-G3.cer')));
    expect(cert.subject).toContain('Apple Root CA - G3');
    // Self-signed root.
    expect(cert.issuer).toBe(cert.subject);
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('availability', () => {
  it('is available in Sandbox with a bundle id', () => {
    expect(new JwsVerifier(base).available).toBe(true);
  });

  it('refuses to run without a bundle id, and says why', () => {
    const v = new JwsVerifier({ ...base, bundleId: undefined });
    expect(v.available).toBe(false);
    expect(v.unavailable).toMatch(/ASC_BUNDLE_ID/);
  });

  // Without it, a correctly signed payload belonging to a different app passes.
  it('refuses Production without an app Apple ID, and explains the consequence', () => {
    const v = new JwsVerifier({ ...base, environment: 'Production' });
    expect(v.available).toBe(false);
    expect(v.unavailable).toMatch(/ASC_APP_APPLE_ID/);
    expect(v.unavailable).toMatch(/different app would pass/);
  });

  it('is available in Production once the app Apple ID is given', () => {
    expect(new JwsVerifier({ ...base, environment: 'Production', appAppleId: 6763390896 }).available).toBe(true);
  });
});

describe('rejecting what Apple did not sign', () => {
  const forged = () => forgeJws({ bundleId: 'com.example.app', productId: 'premium', type: 'Auto-Renewable Subscription' });

  it('rejects a forged transaction while still showing what it claimed', async () => {
    const { payload, outcome } = await new JwsVerifier(base).verify(forged(), 'transaction');
    expect(outcome.verified).toBe(false);
    // The claim is still visible — dropping it silently would hide the attack.
    expect((payload as any).productId).toBe('premium');
    expect((outcome as any).reason).toMatch(/rejected this payload/);
  });

  it('rejects forged renewal info and app transactions too', async () => {
    const v = new JwsVerifier(base);
    for (const kind of ['renewal', 'appTransaction'] as const) {
      expect((await v.verify(forged(), kind)).outcome.verified).toBe(false);
    }
  });

  it('marks a non-retryable failure as such', async () => {
    const { outcome } = await new JwsVerifier(base).verify(forged(), 'transaction');
    expect((outcome as any).recoverable).toBe(false);
  });

  it('handles a malformed JWS without throwing', async () => {
    const { outcome } = await new JwsVerifier(base).verify('not.a.jws', 'transaction');
    expect(outcome.verified).toBe(false);
  });
});

describe('when verification cannot run', () => {
  it('decodes, and says plainly that nothing was verified', async () => {
    const v = new JwsVerifier({ ...base, bundleId: undefined });
    const { payload, outcome } = await v.verify(forgeJws({ productId: 'premium' }), 'transaction');
    expect((payload as any).productId).toBe('premium');
    expect(outcome.verified).toBe(false);
    expect((outcome as any).reason).toMatch(/ASC_BUNDLE_ID/);
    expect((outcome as any).recoverable).toBe(true);
  });
});

describe('decodeWithoutVerifying', () => {
  it('reads the claims', () => {
    expect((decodeWithoutVerifying(forgeJws({ a: 1 })) as any).a).toBe(1);
  });

  it('returns the input unchanged when it is not a JWS', () => {
    expect(decodeWithoutVerifying('nope')).toBe('nope');
    expect(decodeWithoutVerifying('a.b.c')).toBe('a.b.c');
  });
});

describe('verifySignedFields', () => {
  const verifier = new JwsVerifier(base);

  it('verifies a signed scalar, keeping the original alongside', async () => {
    const jws = forgeJws({ productId: 'premium' });
    const out: any = await verifySignedFields({ signedTransactionInfo: jws }, verifier);
    expect(out.signedTransactionInfo).toBe(jws);
    expect(out.signedTransactionInfo_decoded.productId).toBe('premium');
    expect(out.signedTransactionInfo_verification.verified).toBe(false);
  });

  // One bad signature among many is the case that matters; a single
  // response-level flag would bury it.
  it('reports per item across an array', async () => {
    const out: any = await verifySignedFields({ signedTransactions: [forgeJws({ a: 1 }), forgeJws({ a: 2 })] }, verifier);
    expect(out.signedTransactions_decoded).toHaveLength(2);
    expect(out.signedTransactions_verification.verified).toBe(false);
    expect(out.signedTransactions_verification.reason).toMatch(/2 of 2/);
    expect(out.signedTransactions_verification.perItem).toHaveLength(2);
  });

  it('walks nested structures', async () => {
    const out: any = await verifySignedFields(
      { data: [{ lastTransactions: [{ signedRenewalInfo: forgeJws({ autoRenewStatus: 1 }) }] }] },
      verifier
    );
    const node = out.data[0].lastTransactions[0];
    expect(node.signedRenewalInfo_decoded.autoRenewStatus).toBe(1);
    expect(node.signedRenewalInfo_verification.verified).toBe(false);
  });

  it('leaves unrelated fields alone', async () => {
    const out: any = await verifySignedFields({ bundleId: 'com.x', revision: 'r1', signedDate: 1699999999 }, verifier);
    expect(out).toEqual({ bundleId: 'com.x', revision: 'r1', signedDate: 1699999999 });
  });

  it('passes primitives through', async () => {
    expect(await verifySignedFields(null, verifier)).toBeNull();
    expect(await verifySignedFields('plain', verifier)).toBe('plain');
  });
});

describe('accepting a genuine signature', () => {
  // The forgery tests prove rejection. This proves the other half: that a
  // properly chained, properly signed payload is actually accepted — otherwise
  // a verifier that rejected everything would look equally healthy.
  const FIX = path.join(ROOT, 'test/fixtures');
  const der = (n: string) => fs.readFileSync(path.join(FIX, `${n}.der`));

  /** Sign a JWS with the test leaf, presenting the full chain in x5c. */
  function signWithTestChain(claims: Record<string, unknown>): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const header = {
      alg: 'ES256',
      x5c: [der('leaf'), der('int'), der('root')].map((c) => c.toString('base64')),
    };
    const input = `${b64(header)}.${b64(claims)}`;
    const key = createPrivateKey(fs.readFileSync(path.join(FIX, 'leaf.key')));
    const sig = createSign('SHA256').update(input).sign({ key, dsaEncoding: 'ieee-p1363' });
    return `${input}.${Buffer.from(sig).toString('base64url')}`;
  }

  const trusting = () =>
    new JwsVerifier({ ...base, onlineChecks: false, rootCertificates: [der('root')] });

  it('verifies a transaction signed by a trusted chain', async () => {
    const jws = signWithTestChain({
      bundleId: 'com.example.app',
      environment: 'Sandbox',
      productId: 'premium.monthly',
      transactionId: '2000000000000001',
    });
    const { payload, outcome } = await trusting().verify(jws, 'transaction');
    expect(outcome.verified).toBe(true);
    expect((payload as any).productId).toBe('premium.monthly');
  });

  it('rejects the same payload once the trust anchor is Apple’s real root', async () => {
    const jws = signWithTestChain({ bundleId: 'com.example.app', environment: 'Sandbox', productId: 'premium.monthly' });
    // Same bytes, same chain — only the anchor differs. This is the check.
    const { outcome } = await new JwsVerifier(base).verify(jws, 'transaction');
    expect(outcome.verified).toBe(false);
  });

  it('rejects a payload whose bundle id belongs to another app', async () => {
    const jws = signWithTestChain({ bundleId: 'com.someone.else', environment: 'Sandbox', productId: 'premium' });
    const { outcome } = await trusting().verify(jws, 'transaction');
    expect(outcome.verified).toBe(false);
    expect((outcome as any).reason).toMatch(/INVALID_APP_IDENTIFIER|rejected/);
  });

  it('rejects a Production payload when the verifier expects Sandbox', async () => {
    const jws = signWithTestChain({ bundleId: 'com.example.app', environment: 'Production', productId: 'premium' });
    const { outcome } = await trusting().verify(jws, 'transaction');
    expect(outcome.verified).toBe(false);
    expect((outcome as any).reason).toMatch(/INVALID_ENVIRONMENT|rejected/);
  });

  it('rejects a payload whose signature was tampered with after signing', async () => {
    const jws = signWithTestChain({ bundleId: 'com.example.app', environment: 'Sandbox', productId: 'premium' });
    const [h, p] = jws.split('.');
    const swapped = Buffer.from(JSON.stringify({ bundleId: 'com.example.app', environment: 'Sandbox', productId: 'FREE' })).toString('base64url');
    const { outcome } = await trusting().verify(`${h}.${swapped}.${jws.split('.')[2]}`, 'transaction');
    expect(outcome.verified).toBe(false);
    expect(p).not.toBe(swapped);
  });

  it('marks a whole array verified when every signature checks out', async () => {
    const jws = () => signWithTestChain({ bundleId: 'com.example.app', environment: 'Sandbox', productId: 'p' });
    const out: any = await verifySignedFields({ signedTransactions: [jws(), jws()] }, trusting());
    expect(out.signedTransactions_verification).toEqual({ verified: true, count: 2 });
  });

  it('singles out the one bad signature in a batch', async () => {
    const good = signWithTestChain({ bundleId: 'com.example.app', environment: 'Sandbox', productId: 'p' });
    const out: any = await verifySignedFields({ signedTransactions: [good, forgeJws({ productId: 'x' })] }, trusting());
    expect(out.signedTransactions_verification.reason).toMatch(/1 of 2/);
    expect(out.signedTransactions_verification.perItem[0].verified).toBe(true);
    expect(out.signedTransactions_verification.perItem[1].verified).toBe(false);
  });
});
