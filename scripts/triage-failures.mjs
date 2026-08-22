#!/usr/bin/env node
/**
 * Read the failure log and say what it implies about this repo.
 *
 *   npm run triage
 *   node scripts/triage-failures.mjs --dir <path> --since 7d --top 20 --json
 *
 * The log exists so that failures hit in real use feed development — which only
 * happens if something turns a heap of JSONL into "these three operations keep
 * 404ing and none of them is mentioned in the cookbook". That is all this does.
 *
 * Read-only. It never writes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const value = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};

const dir = value('dir', process.env.ASC_FAILURE_LOG_DIR ?? path.join(ROOT, '.asc-logs'));
const top = Number(value('top', '20'));
const sinceMs = (() => {
  const raw = value('since', '');
  const m = /^(\d+)([hd])$/.exec(raw);
  if (!m) return 0;
  return Date.now() - Number(m[1]) * (m[2] === 'h' ? 3_600_000 : 86_400_000);
})();

if (!fs.existsSync(dir)) {
  process.stdout.write(`No failure log at ${dir}. Nothing has gone wrong yet, or nothing was recorded.\n`);
  process.exit(0);
}

const records = [];
for (const file of fs.readdirSync(dir).filter((f) => /^failures.*\.jsonl$/.test(f))) {
  for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    // A torn line from a concurrent append on a network filesystem is skipped,
    // never fatal — this is a reporting tool, not a validator.
    try {
      const r = JSON.parse(line);
      if (sinceMs && Date.parse(r.ts) < sinceMs) continue;
      records.push(r);
    } catch {
      /* Skip. */
    }
  }
}

if (!records.length) {
  process.stdout.write(`No records in ${dir}${sinceMs ? ' for that window' : ''}.\n`);
  process.exit(0);
}

const tally = (fn) => {
  const m = new Map();
  for (const r of records) {
    const k = fn(r);
    if (k === undefined) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

const groups = new Map();
for (const r of records) {
  if (r.kind === 'repeat') continue;
  const key = `${r.operationId ?? r.path ?? r.subtype ?? '(none)'}|${r.status ?? '-'}|${r.code ?? '-'}`;
  const g = groups.get(key) ?? { key, n: 0, attempts: 0, kind: r.kind, requestId: undefined, sample: r };
  g.n += 1;
  g.attempts += r.attempts ?? 1;
  g.requestId ??= r.requestId;
  groups.set(key, g);
}
const ranked = [...groups.values()].sort((a, b) => b.n - a.n);

if (has('json')) {
  process.stdout.write(`${JSON.stringify({ dir, total: records.length, groups: ranked }, null, 2)}\n`);
  process.exit(0);
}

const out = [];
const span = records.map((r) => Date.parse(r.ts)).filter(Number.isFinite);
out.push(`${records.length} records in ${dir}`);
if (span.length) {
  out.push(`  ${new Date(Math.min(...span)).toISOString()} → ${new Date(Math.max(...span)).toISOString()}`);
}
out.push(`  by kind:   ${tally((r) => r.kind).map(([k, n]) => `${k} ${n}`).join(', ')}`);
out.push(`  by source: ${tally((r) => r.source).map(([k, n]) => `${k} ${n}`).join(', ')}`);
out.push(`  sessions:  ${new Set(records.map((r) => r.sid)).size}`);

out.push('', 'Top failures');
for (const g of ranked.slice(0, top)) {
  const [what, status, code] = g.key.split('|');
  out.push(
    `  ${String(g.n).padStart(4)}  ${g.kind.padEnd(17)} ${what} ${status !== '-' ? status : ''}${
      code !== '-' ? ` ${code}` : ''
    }`
  );
  out.push(`        ${g.sample.message ?? ''}`.slice(0, 160));
  if (g.requestId) out.push(`        x-request-id: ${g.requestId}   ← quote this to Apple`);
}

const swallowed = ranked.filter((g) => g.kind === 'swallowed');
if (swallowed.length) {
  out.push('', 'Swallowed — nobody ever saw these');
  out.push('  A run of these means a macro reported a confident verdict built on data it never got.');
  for (const g of swallowed) out.push(`  ${String(g.n).padStart(4)}  ${g.sample.subtype}: ${g.sample.message}`);
}

const stranded = records.filter((r) => r.kind === 'asset-upload' && r.subtype === 'reserved-but-incomplete');
if (stranded.length) {
  out.push('', `${stranded.length} stranded asset reservation(s) — each one is sitting in AWAITING_UPLOAD`);
  out.push('  and will block the next upload with a 409 until it is deleted. COOKBOOK #14.');
}

// The point of the whole exercise: what should be written that has not been.
const RULES = [
  [(g) => g.status === '404' && g.n >= 3, 'COOKBOOK entry: this resource is not where its URL pattern implies'],
  [(g) => g.sample.subtype === 'empty-list' && g.n >= 3, 'COOKBOOK entry: filter semantics on this collection'],
  [(g) => g.sample.subtype === 'truncated-pagination' && g.n >= 3, 'SKILL.md: paginate is not the default'],
  [(g) => g.sample.subtype === 'territory-format' && g.n >= 3, 'COOKBOOK #2 exists but was not read — make it louder'],
  [(g) => g.n >= 5 && g.sample.operationId, 'macro candidate: this chain is being repeated'],
  [(g) => ['409', '422'].includes(g.status ?? '') && g.n >= 2, 'risk-tier or confirmation-copy gap'],
];
const gaps = [];
for (const g of ranked) {
  const status = g.key.split('|')[1];
  for (const [test, suggestion] of RULES) {
    if (test({ ...g, status })) {
      gaps.push(`  ${g.key.split('|')[0]} (${g.n}×) → ${suggestion}`);
      break;
    }
  }
}
if (gaps.length) out.push('', 'Suggested', ...gaps);

// Cookbook coverage: the closing line of COOKBOOK.md asks for exactly this.
try {
  const cookbook = fs.readFileSync(path.join(ROOT, 'docs', 'COOKBOOK.md'), 'utf8').toLowerCase();
  const uncovered = ranked
    .filter((g) => g.n >= 2)
    .map((g) => g.key.split('|')[0])
    .filter((what) => what && what !== '(none)' && !cookbook.includes(what.toLowerCase().split('_')[0]));
  if (uncovered.length) {
    out.push('', `${uncovered.length} failure group(s) match no cookbook entry:`);
    for (const u of [...new Set(uncovered)].slice(0, top)) out.push(`  ${u}`);
  }
} catch {
  /* Running outside the checkout; skip the coverage section. */
}

process.stdout.write(`${out.join('\n')}\n`);
