/**
 * Contract tests catch Apple drift and hand-editing without calling Apple.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STOREKIT_OPERATIONS } from '../src/storekit.js';
import { loadIndex } from '../src/spec.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

describe('spec index', () => {
  // The committed index must be reproducible from the committed spec, so a
  // hand-edit or a stale rebuild fails here rather than at runtime.
  it('matches what the generator produces from the committed spec', () => {
    const committed = fs.readFileSync(path.join(ROOT, 'spec/index.json'), 'utf8');
    execFileSync('node', ['scripts/build-index.mjs'], { cwd: ROOT, stdio: 'pipe' });
    const regenerated = fs.readFileSync(path.join(ROOT, 'spec/index.json'), 'utf8');
    expect(regenerated).toBe(committed);
  });

  it('classifies every operation into a known tier', () => {
    const known = new Set(['READ', 'WRITE', 'RELEASE', 'REVENUE', 'INFRASTRUCTURE', 'ACCESS', 'DESTRUCTIVE']);
    for (const op of loadIndex().operations) expect(known.has(op.risk)).toBe(true);
  });

  it('marks every GET as READ and no GET as anything else', () => {
    for (const op of loadIndex().operations) {
      if (op.method === 'GET') expect(op.risk).toBe('READ');
      else expect(op.risk).not.toBe('READ');
    }
  });

  it('declares every path placeholder as a path parameter', () => {
    for (const op of loadIndex().operations) {
      const inTemplate = [...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      for (const p of inTemplate) expect(op.pathParams).toContain(p);
    }
  });

  // A rule change that silently reclassifies hundreds of operations should be
  // a visible diff, not a surprise in production.
  it('keeps the risk distribution stable', () => {
    expect(loadIndex().byRisk).toMatchSnapshot();
  });
});

describe('StoreKit catalogue vs Apple’s own client', () => {
  const parsedPath = path.join(ROOT, 'spec/storekit-endpoints.json');

  it('covers exactly the endpoint set Apple’s library defines', () => {
    const parsed = JSON.parse(fs.readFileSync(parsedPath, 'utf8'));
    // Compare path SHAPE: Apple names the first segment `anyTransactionId`
    // where we call it `transactionId`. The name is ours; the structure is not.
    const norm = (s: string) => s.replace(/\{[^}]+\}/g, '{}');
    const theirs = new Set(parsed.operations.map((o: any) => `${o.method} ${norm(o.path)}`));
    const ours = new Set(STOREKIT_OPERATIONS.map((o) => `${o.method} ${norm(o.path)}`));
    expect([...theirs].filter((x) => !ours.has(x as string))).toEqual([]);
    expect([...ours].filter((x) => !theirs.has(x))).toEqual([]);
  });

  it('records which Apple release the catalogue was taken from', () => {
    const parsed = JSON.parse(fs.readFileSync(parsedPath, 'utf8'));
    expect(parsed.source).toMatch(/^apple\/app-store-server-library-node@/);
  });
});
