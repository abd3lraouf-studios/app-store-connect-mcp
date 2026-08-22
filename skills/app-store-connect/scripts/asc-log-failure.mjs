#!/usr/bin/env node
/**
 * Record one App Store Connect failure that the server could not see.
 *
 * The server logs its own HTTP failures from inside the process. This exists
 * for the other kind: the call that returned 200 and still misled you — an
 * empty list caused by a two-letter territory, a page read as complete, a
 * "no subscriptions" that was really a one-time purchase. Those never reach the
 * HTTP layer as failures, and they are the ones that turn into cookbook entries.
 *
 *   asc-log-failure.mjs '{"kind":"interpretation","subtype":"empty-list", ...}'
 *   asc-log-failure.mjs --stdin   < payload.json
 *
 * This file deliberately contains no path-precedence, redaction, dedupe or
 * rotation logic. All of that lives in the package's failure-log module, which
 * this script locates and delegates to. The fallback at the bottom is a
 * knowingly lesser thing, marked as such in what it writes, for the case where
 * the package cannot be found at all.
 *
 * It exits 0 no matter what. A logging script that can fail a caller is worse
 * than no logging script.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_NAME = '@abd3lraouf/app-store-connect-mcp';
const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readPayload() {
  const arg = process.argv[2];
  if (!arg) return null;
  const raw = arg === '--stdin' ? fs.readFileSync(0, 'utf8') : arg;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // Not JSON: treat the whole argument as the message rather than losing it.
    return { kind: 'interpretation', message: raw };
  }
}

/** Is `dir` the root of this package — a checkout or an install? */
function isPackageRoot(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name === PKG_NAME;
  } catch {
    return false;
  }
}

function upwardPackageRoot(start) {
  let dir = start;
  for (let i = 0; i < 12; i += 1) {
    if (isPackageRoot(dir)) return dir;
    const nested = path.join(dir, 'node_modules', ...PKG_NAME.split('/'));
    if (isPackageRoot(nested)) return nested;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** The compiled failure-log module, or undefined if this machine has no copy. */
function resolveEntry() {
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, '.install.json'), 'utf8'));
    if (installed.entry && fs.existsSync(installed.entry)) return installed.entry;
  } catch {
    /* Not installed by the installer, or the record is stale. Keep looking. */
  }

  try {
    return createRequire(import.meta.url).resolve(`${PKG_NAME}/failure-log`);
  } catch {
    /* Not resolvable from here. */
  }

  // `install-skill.mjs --link` symlinks this directory into the checkout, so the
  // script's real path is inside the repo whose dist/ we want.
  for (const start of [path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))), process.cwd()]) {
    const root = upwardPackageRoot(start);
    const entry = root && path.join(root, 'dist', 'failure-log.js');
    if (entry && fs.existsSync(entry)) return entry;
  }
  return undefined;
}

/**
 * Last resort. One scrub pass, one append, no cleverness — and it says
 * `degraded` so nobody mistakes its output for the real thing.
 */
function fallback(payload) {
  const dir = process.env.ASC_FAILURE_LOG_DIR
    ? process.env.ASC_FAILURE_LOG_DIR
    : path.join(SKILL_DIR, '.logs');
  const line = JSON.stringify({
    v: 1,
    ts: new Date().toISOString(),
    source: 'skill',
    degraded: true,
    ...payload,
  })
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/g, '[redacted:jwt]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted:pem]')
    .replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1***@$2');

  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(path.join(dir, 'failures.jsonl'), 'a');
  try {
    fs.writeSync(fd, Buffer.from(`${line.slice(0, 8192)}\n`, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

async function main() {
  const payload = readPayload();
  if (!payload) return;

  // Lets the module offer <skillDir>/.logs as a candidate when there is no
  // checkout to write into.
  if (!process.env.ASC_SKILL_DIR) process.env.ASC_SKILL_DIR = SKILL_DIR;

  const entry = resolveEntry();
  if (entry) {
    const { recordFailure } = await import(pathToFileURL(entry).href);
    recordFailure({ kind: 'interpretation', message: '', ...payload, source: 'skill' });
    return;
  }
  fallback(payload);
}

try {
  await main();
} catch {
  /* Never let recording a problem become a second problem. */
} finally {
  process.exitCode = 0;
}
