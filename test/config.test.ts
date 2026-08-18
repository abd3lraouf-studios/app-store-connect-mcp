import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

const KEY = 'keychain:svc';
const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith('ASC_')) delete process.env[k];
  Object.assign(process.env, saved);
});

describe('credential source', () => {
  it('refuses to start with no key, and says how to supply one', () => {
    delete process.env.ASC_KEY;
    delete process.env.ASC_PRIVATE_KEY_PATH;
    delete process.env.ASC_PRIVATE_KEY;
    expect(() => loadConfig([])).toThrow(/No API key configured[\s\S]*keychain:/);
  });

  it('prefers --key over the environment', () => {
    process.env.ASC_KEY = 'keychain:from-env';
    expect(loadConfig(['--key', 'keychain:from-flag']).keyRef).toBe('keychain:from-flag');
  });

  it('accepts the inline and path environment variables', () => {
    process.env.ASC_PRIVATE_KEY_PATH = '/tmp/AuthKey.p8';
    expect(loadConfig([]).keyRef).toBe('/tmp/AuthKey.p8');
  });
});

describe('safety mode', () => {
  it('defaults to gating the strong tiers', () => {
    expect(loadConfig(['--key', KEY]).safety).toBe('default');
  });

  it.each([
    ['--read-only', 'read-only'],
    ['--confirm', 'confirm'],
    ['--no-confirm', 'no-confirm'],
  ])('%s selects %s', (flag, expected) => {
    expect(loadConfig(['--key', KEY, flag]).safety).toBe(expected);
  });

  // If someone passes both, the safer one has to win.
  it('lets --read-only win over --no-confirm', () => {
    expect(loadConfig(['--key', KEY, '--no-confirm', '--read-only']).safety).toBe('read-only');
  });
});

describe('transport', () => {
  it('defaults to stdio on loopback', () => {
    const c = loadConfig(['--key', KEY]);
    expect(c.transport).toBe('stdio');
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(8787);
  });

  it('accepts --transport http and --http', () => {
    expect(loadConfig(['--key', KEY, '--transport', 'http']).transport).toBe('http');
    expect(loadConfig(['--key', KEY, '--http']).transport).toBe('http');
  });

  it('reads host, port and token', () => {
    const c = loadConfig(['--key', KEY, '--host', '0.0.0.0', '--port', '9999', '--http-token', 'tok']);
    expect(c.host).toBe('0.0.0.0');
    expect(c.port).toBe(9999);
    expect(c.httpToken).toBe('tok');
  });

  it('supports --flag=value form', () => {
    expect(loadConfig(['--key=keychain:inline']).keyRef).toBe('keychain:inline');
  });
});

describe('storekit environment', () => {
  it('defaults to Production', () => {
    expect(loadConfig(['--key', KEY]).storekitEnvironment).toBe('Production');
  });

  it('accepts Sandbox', () => {
    expect(loadConfig(['--key', KEY, '--storekit-env', 'Sandbox']).storekitEnvironment).toBe('Sandbox');
  });

  it('treats an unrecognised value as Production rather than failing open to Sandbox', () => {
    expect(loadConfig(['--key', KEY, '--storekit-env', 'nonsense']).storekitEnvironment).toBe('Production');
  });
});
