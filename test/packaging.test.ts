/**
 * What actually ships.
 *
 * `files` in package.json is an allowlist, and the failure mode is silent: the
 * package installs, the server starts, and something it needs at runtime is
 * simply absent. That nearly shipped here — without certs/, signature
 * verification would have quietly reported itself unavailable to every npm
 * user while the repository's own tests passed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let files: string[];
let sizeBytes: number;

beforeAll(() => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  const parsed = JSON.parse(out)[0];
  files = parsed.files.map((f: { path: string }) => f.path);
  sizeBytes = parsed.size;
}, 120_000);

describe('runtime assets are published', () => {
  // Without this the server still starts, and silently cannot verify a
  // signature — the worst possible way for it to be missing.
  it('ships Apple Root CA, or signature verification is dead on arrival', () => {
    expect(files).toContain('certs/AppleRootCA-G3.cer');
  });

  it('ships the spec index and generated enums the tools read', () => {
    expect(files).toContain('spec/index.json');
    expect(files).toContain('spec/enums.json');
    expect(files).toContain('spec/apple-openapi.json');
  });

  // The tool descriptions point the model at this; a competitor ships the
  // instruction without the file.
  it('ships the cookbook it tells the model to read', () => {
    expect(files).toContain('docs/COOKBOOK.md');
  });

  it('ships the executable entry point with a shebang', () => {
    expect(files).toContain('dist/index.js');
  });
});

describe('legal files travel with the code', () => {
  it('ships LICENSE and NOTICE', () => {
    expect(files).toContain('LICENSE');
    expect(files).toContain('NOTICE');
  });
});

describe('nothing sensitive is published', () => {
  it.each([/\.p8$/, /AuthKey/i, /^\.env/, /_test_private_key/])('excludes %s', (pattern) => {
    expect(files.filter((f) => pattern.test(f))).toEqual([]);
  });

  // The generated chain is a real key pair, harmless but pointless to ship.
  it('excludes tests and their fixtures', () => {
    expect(files.filter((f) => f.startsWith('test/'))).toEqual([]);
  });

  it('stays a reasonable size', () => {
    expect(sizeBytes).toBeLessThan(5 * 1024 * 1024);
  });
});
