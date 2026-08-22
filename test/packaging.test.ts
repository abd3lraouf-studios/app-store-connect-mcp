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
import fs from 'node:fs';
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
  // npm 11 returns an array of packed packages; npm 12 returns an object keyed
  // by package name. The release job installs npm@latest while CI uses the
  // bundled npm, so the two disagree — and reading [0] made the release fail
  // on a green CI, which is the least useful place to discover a format change.
  const raw: unknown = JSON.parse(out);
  const parsed = (Array.isArray(raw) ? raw[0] : Object.values(raw as Record<string, unknown>)[0]) as {
    files: { path: string }[];
    size: number;
  };
  if (!parsed?.files) {
    throw new Error(`npm pack --json returned an unrecognised shape: ${out.slice(0, 200)}`);
  }
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

  // The skill's logging script locates this module through the package's
  // exports map. Publishing the map without the file is the precise failure
  // this suite exists to catch: everything resolves, and nothing is recorded.
  it('ships the failure-log module its exports map promises', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const entry = pkg.exports['./failure-log'].default.replace(/^\.\//, '');
    expect(files).toContain(entry);
    expect(files).toContain('dist/failure-log.js');
  });

  it('ships the skill and the one script allowed to write', () => {
    expect(files).toContain('skills/app-store-connect/SKILL.md');
    expect(files).toContain('skills/app-store-connect/scripts/asc-log-failure.mjs');
    expect(files.filter((f) => f.startsWith('skills/app-store-connect/references/')).length).toBeGreaterThan(0);
  });
});

describe('legal files travel with the code', () => {
  it('ships LICENSE and NOTICE', () => {
    expect(files).toContain('LICENSE');
    expect(files).toContain('NOTICE');
  });
});

describe('nothing sensitive is published', () => {
  // Captured failures carry app and resource IDs, and a stale .install.json
  // would point a stranger's install at a path on this machine.
  it.each([/\.p8$/, /AuthKey/i, /^\.env/, /_test_private_key/, /\.jsonl$/, /^\.asc-logs\//, /\.install\.json$/])(
    'excludes %s',
    (pattern) => {
      expect(files.filter((f) => pattern.test(f))).toEqual([]);
    }
  );

  // The generated chain is a real key pair, harmless but pointless to ship.
  it('excludes tests and their fixtures', () => {
    expect(files.filter((f) => f.startsWith('test/'))).toEqual([]);
  });

  it('stays a reasonable size', () => {
    expect(sizeBytes).toBeLessThan(5 * 1024 * 1024);
  });
});
