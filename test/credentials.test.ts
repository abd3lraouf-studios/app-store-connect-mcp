/**
 * Credential resolution is tested against a stub `security` binary placed
 * ahead of the real one on PATH — never the machine's actual keychain, which
 * would make the suite depend on the developer's login session.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCredentials } from '../src/credentials.js';

// A syntactically valid PEM; never used to sign anything in this file.
const PEM = ['-----BEGIN PRIVATE KEY-----', 'MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg', '-----END PRIVATE KEY-----'].join('\n');

let binDir: string;
let originalPath: string | undefined;

/** Install a fake `security` that prints whatever the fixture says. */
function stubSecurity(script: string): void {
  fs.writeFileSync(path.join(binDir, 'security'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

beforeAll(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-cred-'));
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${process.env.PATH}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  fs.rmSync(binDir, { recursive: true, force: true });
});

// The Keychain is macOS-only, and the stub below is a POSIX shell script, so
// there is nothing meaningful to assert elsewhere. The file and inline paths
// are cross-platform and still run everywhere.
const onMac = process.platform === 'darwin';

describe.skipIf(!onMac)('keychain envelope', () => {
  it('reads the PEM and takes the identifiers from the envelope', () => {
    const envelope = Buffer.from(
      JSON.stringify({ issuerID: 'issuer-from-keychain', keyID: 'KEYFROMKC', privateKeyPEM: PEM })
    ).toString('base64');
    stubSecurity(`echo '${envelope}'`);

    const creds = resolveCredentials({ keyRef: 'keychain:test-service' });
    expect(creds.privateKey).toContain('BEGIN PRIVATE KEY');
    expect(creds.issuerId).toBe('issuer-from-keychain');
    expect(creds.keyId).toBe('KEYFROMKC');
    expect(creds.source).toBe('keychain:test-service');
  });

  // This is the drift that produced a silent 401 in real use: a config naming
  // a key ID that no longer matches the key material beside it.
  it('lets the envelope override identifiers passed in by config', () => {
    const envelope = Buffer.from(
      JSON.stringify({ issuerID: 'right-issuer', keyID: 'RIGHTKEY', privateKeyPEM: PEM })
    ).toString('base64');
    stubSecurity(`echo '${envelope}'`);

    const creds = resolveCredentials({
      keyRef: 'keychain:test-service',
      issuerId: 'stale-issuer',
      keyId: 'STALEKEY',
    });
    expect(creds.keyId).toBe('RIGHTKEY');
    expect(creds.issuerId).toBe('right-issuer');
  });

  it('falls back to a bare PEM stored without the JSON envelope', () => {
    stubSecurity(`cat <<'EOF'\n${PEM}\nEOF`);
    const creds = resolveCredentials({
      keyRef: 'keychain:test-service',
      issuerId: 'i',
      keyId: 'k',
    });
    expect(creds.privateKey).toContain('BEGIN PRIVATE KEY');
  });

  it('passes the account through when the reference names one', () => {
    stubSecurity(`echo "$@" >&2; cat <<'EOF'\n${PEM}\nEOF`);
    const creds = resolveCredentials({ keyRef: 'keychain:svc/acct', issuerId: 'i', keyId: 'k' });
    expect(creds.source).toBe('keychain:svc/acct');
  });

  it('explains itself when the keychain item is missing', () => {
    stubSecurity('exit 44');
    expect(() => resolveCredentials({ keyRef: 'keychain:absent' })).toThrow(/No keychain item/);
  });

  it('rejects an item holding something that is not a PEM', () => {
    stubSecurity(`echo '${Buffer.from(JSON.stringify({ issuerID: 'i', keyID: 'k' })).toString('base64')}'`);
    expect(() => resolveCredentials({ keyRef: 'keychain:test-service' })).toThrow(/no PEM private key/);
  });

  it('rejects a malformed reference', () => {
    expect(() => resolveCredentials({ keyRef: 'keychain:' })).toThrow(/Malformed keychain reference/);
  });
});

describe('other sources', () => {
  it('reads a file path', () => {
    const f = path.join(binDir, 'AuthKey.p8');
    fs.writeFileSync(f, PEM);
    const creds = resolveCredentials({ keyRef: f, issuerId: 'i', keyId: 'k' });
    expect(creds.source).toBe(`file:${f}`);
    expect(creds.privateKey).toContain('BEGIN');
  });

  it('reports a missing file rather than failing later at sign time', () => {
    expect(() => resolveCredentials({ keyRef: '/nope/AuthKey.p8', issuerId: 'i', keyId: 'k' })).toThrow(
      /Private key file not found/
    );
  });

  it('accepts an inline PEM', () => {
    const creds = resolveCredentials({ keyRef: PEM, issuerId: 'i', keyId: 'k' });
    expect(creds.source).toMatch(/inline env/);
  });

  it('always terminates the key with a newline', () => {
    const creds = resolveCredentials({ keyRef: PEM, issuerId: 'i', keyId: 'k' });
    expect(creds.privateKey.endsWith('\n')).toBe(true);
  });
});

describe('no key at all', () => {
  it('says how to supply one', () => {
    expect(() => resolveCredentials({ keyRef: '' })).toThrow(/No API key configured[\s\S]*keychain:/);
  });
});

describe('required identifiers', () => {
  it('refuses to proceed without an issuer id', () => {
    expect(() => resolveCredentials({ keyRef: PEM, keyId: 'k' })).toThrow(/Missing issuer ID/);
  });

  it('refuses to proceed without a key id', () => {
    expect(() => resolveCredentials({ keyRef: PEM, issuerId: 'i' })).toThrow(/Missing key ID/);
  });
});
