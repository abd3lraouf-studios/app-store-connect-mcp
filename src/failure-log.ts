/**
 * Where App Store Connect failures go to be remembered.
 *
 * Every failure this server produces currently exists only as a tool result in
 * a client transcript: the moment the conversation ends, Apple's `x-request-id`
 * — the one value Apple support asks for — is gone, and so is any evidence of
 * which operations a model tried and could not find. This module is the
 * smallest thing that fixes that.
 *
 * Three properties matter more than features here:
 *
 *  1. It can never break a tool call. `recordFailure` returns void, catches
 *     everything, and disables itself rather than throwing twice.
 *  2. It never writes to stdout. stdout is the JSON-RPC channel; a single stray
 *     byte corrupts the session, which `test/stdio.test.ts` exists to prevent.
 *  3. It never writes a secret. Headers and request bodies are excluded by
 *     construction rather than by filtering — `appStoreReviewDetails` carries a
 *     live `demoAccountPassword` in a plain body, and a body-logging design
 *     would put it on disk on the first 400.
 *
 * Writes are synchronous by design. The server exits via `process.exit(0)`
 * (see `src/index.ts`), which discards an async append in flight — and failures
 * near a shutdown are exactly the ones worth having.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Kept as a literal rather than read from package.json at runtime: this runs on
 * a cold error path, and `scripts/preflight-release.mjs` guards the drift.
 */
const PKG_NAME = '@abd3lraouf/app-store-connect-mcp';

const LOG_NAME = 'failures.jsonl';
const SCHEMA_VERSION = 1;

/**
 * The line cap is not cosmetic. A single `writeSync` of a bounded buffer to a
 * descriptor opened O_APPEND is atomic with respect to other writers; that is
 * what lets the server process and the skill script share one file with no
 * lock. Lift this and the guarantee goes with it.
 */
const MAX_LINE_BYTES = 8 * 1024;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const KEEP_ROTATED = 3;
const STAT_EVERY = 32;

const DEDUPE_WINDOW_MS = 60_000;
const DEDUPE_MAX_KEYS = 200;

const MAX_STRING = 500;
const MAX_ERRORS = 5;
const MAX_BODY_KEYS = 40;
const MAX_WARNINGS = 3;
const MAX_CONSECUTIVE_FAILURES = 3;

export type FailureKind =
  | 'http'
  | 'network'
  | 'tool'
  | 'swallowed'
  | 'partial'
  | 'asset-upload'
  | 'segment-download'
  | 'interpretation'
  | 'repeat';

export interface FailureEvent {
  kind: FailureKind;
  message: string;
  tool?: string;
  operationId?: string;
  method?: string;
  /** Prefer the spec's path template; a rendered path is normalised on the way in. */
  path?: string;
  status?: number;
  code?: string;
  requestId?: string;
  ambiguous?: boolean;
  attempts?: number;
  /** Apple's error payload only — never a response body, never a request body. */
  detail?: unknown;
  /** Non-Apple hosts (pre-signed asset and segment URLs): hostname only. */
  host?: string;
  /** Request body KEYS. Never values. */
  bodyKeys?: string[];
  subtype?: string;
  /** Free text from the skill. May quote a customer review, so treated as data. */
  note?: string;
  source?: 'server' | 'skill';
  /** Set by the degraded fallback in the skill script. */
  degraded?: boolean;
  /** Arbitrary small counters, e.g. availability's {changed, failed}. */
  counts?: Record<string, number>;
}

interface FailureContext {
  tool?: string;
  operationId?: string;
}

const context = new AsyncLocalStorage<FailureContext>();

/**
 * Tag everything logged inside `fn` with the tool that caused it.
 *
 * A module-level "current tool" global would mis-attribute: `src/inflight.ts`
 * shows tool calls genuinely interleave at await points. This is what lets
 * `http.ts` stay ignorant of tools while its records still name one.
 */
export function runWithFailureContext<T>(ctx: FailureContext, fn: () => Promise<T>): Promise<T> {
  return context.run(ctx, fn);
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const UNRESOLVED = Symbol('unresolved');
let cachedDir: string | null | typeof UNRESOLVED = UNRESOLVED;
let rejectedDirs: string[] = [];
let reResolved = false;
let disabled = false;
let inRecord = false;
let warnings = 0;
let consecutiveFailures = 0;
let bytesSinceStat = 0;
let writesSinceStat = 0;

const sessionId = randomBytes(3).toString('hex');

interface DedupeEntry {
  n: number;
  first: number;
  last: number;
  seed: { kind: FailureKind; operationId?: string; path?: string; status?: number; code?: string };
}
const seen = new Map<string, DedupeEntry>();

/** Test seam. Resets everything this module remembers. */
export function __resetFailureLog(): void {
  cachedDir = UNRESOLVED;
  rejectedDirs = [];
  reResolved = false;
  disabled = false;
  inRecord = false;
  warnings = 0;
  consecutiveFailures = 0;
  bytesSinceStat = 0;
  writesSinceStat = 0;
  seen.clear();
}

/** stderr only, and at most a few times per process. Never stdout. */
function warnOnce(message: string): void {
  if (warnings >= MAX_WARNINGS) return;
  warnings += 1;
  try {
    console.error(`app-store-connect-mcp: ${message}`);
  } catch {
    /* A broken stderr must not become an exception on an error path. */
  }
}

// ---------------------------------------------------------------------------
// Locating a place to write
// ---------------------------------------------------------------------------

function isOff(): boolean {
  const v = (process.env.ASC_FAILURE_LOG ?? '').toLowerCase();
  return v === '0' || v === 'off' || v === 'false';
}

function isForcedOn(): boolean {
  const v = (process.env.ASC_FAILURE_LOG ?? '').toLowerCase();
  return v === '1' || v === 'on' || v === 'true';
}

function expandTilde(p: string): string {
  return p.startsWith('~/') || p === '~' ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Is `root` a working checkout of *this* package, as opposed to an installed
 * copy of it?
 *
 * `files` in package.json is `["dist","spec","certs","docs/COOKBOOK.md","NOTICE"]`,
 * so a published tarball contains no `src/`; npm strips `.git` unconditionally.
 * Requiring both is therefore a fact about what npm ships, not a guess — and
 * `test/packaging.test.ts` already enforces the allowlist it rests on.
 *
 * Deliberately not the git remote: forks, SSH-vs-HTTPS and `git worktree` all
 * break that, and it costs a subprocess on an error path.
 */
function isCheckout(root: string): boolean {
  if (root.split(path.sep).includes('node_modules')) return false;
  return fs.existsSync(path.join(root, 'src')) && fs.existsSync(path.join(root, '.git'));
}

/**
 * Walk up looking for this package's own checkout. Bounded; stops at a root.
 * Exported because this is where the "is it really the dev repo" decision is
 * made, and it is worth testing against fabricated trees rather than only
 * through whatever directory the tests happen to run in.
 */
export function findCheckoutUpward(start: string): string | undefined {
  let dir = start;
  for (let i = 0; i < 12; i += 1) {
    if (path.basename(dir) === 'node_modules') return undefined;
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      let name: unknown;
      try {
        name = JSON.parse(fs.readFileSync(manifest, 'utf8')).name;
      } catch {
        name = undefined;
      }
      if (name === PKG_NAME) {
        // Right package. Either it is a checkout or it is an installed copy;
        // in both cases there is nothing further up worth finding.
        return isCheckout(dir) ? dir : undefined;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

function skillDirFromInstall(): string | undefined {
  const explicit = process.env.ASC_SKILL_DIR;
  if (explicit) return expandTilde(explicit);
  return undefined;
}

/**
 * The probe is opening the real log file, so it leaves no litter: an empty
 * `failures.jsonl` is the artifact we were about to create anyway.
 *
 * `accessSync(W_OK)` would not do. ACLs, macOS TCC and a container running as
 * root all make mode bits lie; `openSync` is the syscall that actually decides.
 */
function probe(dir: string): string | undefined {
  try {
    mkdirp(dir);
    fs.closeSync(fs.openSync(path.join(dir, LOG_NAME), 'a'));
    return dir;
  } catch {
    return undefined;
  }
}

/** How far up an absent destination may be created. A log directory is not 64 deep. */
const MKDIR_MAX_DEPTH = 64;

/**
 * `mkdirSync(dir, { recursive: true })` with a guaranteed end.
 *
 * Node's recursive mkdir does not have one. On Linux, pointing it anywhere
 * under `/proc` — a filesystem that answers ENOENT for a missing child and
 * EPERM for creating one — puts it in a loop it never leaves: it hangs, it
 * cannot be interrupted, and there is nothing to catch. A single
 * `ASC_FAILURE_LOG_DIR` typo would have hung the server on the first failure
 * it tried to record, which is precisely the moment it must not.
 *
 * Creating the chain here instead means every mkdir is non-recursive, so an
 * EPERM is an EPERM and probe() simply moves on.
 */
function mkdirp(dir: string): void {
  const target = path.resolve(dir);
  const missing: string[] = [];
  let cur = target;
  while (!fs.existsSync(cur)) {
    if (missing.length >= MKDIR_MAX_DEPTH) throw new Error(`${target} is too deep to create.`);
    missing.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (const d of missing.reverse()) {
    try {
      fs.mkdirSync(d);
    } catch (error) {
      // Two writers can race to create the same directory; losing that race is
      // the outcome we wanted. Anything else is a real refusal.
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
    }
  }
}

function candidates(): string[] {
  const out: string[] = [];
  const push = (d: string | undefined) => {
    if (d && !out.includes(d) && !rejectedDirs.includes(d)) out.push(d);
  };

  const here = path.dirname(fileURLToPath(import.meta.url));
  const fromModule = findCheckoutUpward(here);
  const fromCwd = findCheckoutUpward(process.cwd());
  if (fromModule) push(path.join(fromModule, '.asc-logs'));
  if (fromCwd) push(path.join(fromCwd, '.asc-logs'));

  const foundCheckout = out.length > 0;
  const skillDir = skillDirFromInstall();

  // On a machine with no checkout and no installed skill, writing anywhere is
  // something the owner never asked for. Installing the skill, setting
  // ASC_FAILURE_LOG_DIR, or ASC_FAILURE_LOG=1 are the three ways to opt in.
  if (!foundCheckout && !skillDir && !isForcedOn()) return [];

  if (skillDir) push(path.join(skillDir, '.logs'));
  push(path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'app-store-connect-mcp'));
  push(path.join(os.tmpdir(), 'asc-mcp-failures'));
  return out;
}

/** The directory failures are written to, or null when logging is off. Memoised. */
export function resolveLogDir(): string | null {
  if (cachedDir !== UNRESOLVED) return cachedDir;
  cachedDir = null;

  if (isOff()) return null;

  const explicit = process.env.ASC_FAILURE_LOG_DIR;
  if (explicit) {
    // An explicit destination that silently becomes a different destination is
    // worse than no logging at all, so this never falls through.
    const dir = probe(expandTilde(explicit));
    if (dir) {
      cachedDir = dir;
      return dir;
    }
    warnOnce(`ASC_FAILURE_LOG_DIR=${explicit} is not writable; failure logging is off.`);
    return null;
  }

  for (const candidate of candidates()) {
    const dir = probe(candidate);
    if (dir) {
      cachedDir = dir;
      return dir;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shaping a record
// ---------------------------------------------------------------------------

function cap(value: unknown, max = MAX_STRING): string | undefined {
  if (value === undefined || value === null) return undefined;
  let s: string;
  if (typeof value === 'string') {
    s = value;
  } else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    s = String(value);
  } else {
    // Never let an object reach String(): "[object Object]" in a failure record
    // is worse than nothing, because it looks like data.
    try {
      s = JSON.stringify(value) ?? typeof value;
    } catch {
      s = '[uncapturable]';
    }
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Apple ids are numeric, uuid-shaped, or long opaque strings. Collection names
 * such as `inAppPurchasesV2` are not, and must survive — which is why the
 * opaque case demands 20 characters and a digit rather than the 16 that would
 * swallow real path segments.
 */
const NUMERIC = /^\d+$/;
const UUIDISH = /^[0-9a-fA-F]{8}-[0-9a-fA-F-]{4,}$/;
const OPAQUE = /^(?=.*\d)[A-Za-z0-9_-]{20,}$/;

function normalisePath(p?: string): string | undefined {
  if (!p) return undefined;
  const bare = p.split('?')[0] ?? p;
  return bare
    .split('/')
    .map((seg) => (seg && (NUMERIC.test(seg) || UUIDISH.test(seg) || OPAQUE.test(seg)) ? '{id}' : seg))
    .join('/');
}

/**
 * Reduce Apple's error payload to the parts worth keeping. Both API shapes are
 * handled, mirroring `describeError` in `src/http.ts`.
 */
function reduceDetail(detail: unknown): unknown {
  if (detail === undefined || detail === null) return undefined;
  if (typeof detail === 'object') {
    const d = detail as Record<string, any>;
    if (Array.isArray(d.errors)) {
      return {
        errors: d.errors.slice(0, MAX_ERRORS).map((e: any) => ({
          status: cap(e?.status),
          code: cap(e?.code),
          title: cap(e?.title),
          detail: cap(e?.detail),
        })),
      };
    }
    if (d.errorCode !== undefined || d.errorMessage !== undefined) {
      return { errorCode: cap(d.errorCode), errorMessage: cap(d.errorMessage) };
    }
    if (typeof d.cause === 'string') return { cause: cap(d.cause) };
  }
  if (typeof detail === 'string') return cap(detail);
  try {
    return cap(JSON.stringify(detail));
  } catch {
    return undefined;
  }
}

/**
 * Dotted key paths of a request body, values discarded.
 *
 * Exported because the alternative — callers passing the body and trusting this
 * module to strip it — is the design that eventually writes a demo account
 * password to disk.
 */
export function describeBodyKeys(body: unknown, prefix = '', depth = 0): string[] {
  if (depth > 3 || body === null || typeof body !== 'object') return [];
  const keys: string[] = [];
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    const full = prefix ? `${prefix}.${k}` : k;
    keys.push(full);
    if (v && typeof v === 'object' && !Array.isArray(v)) keys.push(...describeBodyKeys(v, full, depth + 1));
    if (keys.length >= MAX_BODY_KEYS) break;
  }
  return keys.slice(0, MAX_BODY_KEYS);
}

/**
 * Defence in depth, applied once to the serialised line.
 *
 * Nothing here is the primary control — headers and bodies are excluded by
 * construction. These catch the case where a secret arrives inside a message
 * or an error detail Apple echoed back.
 */
const SCRUBBERS: Array<[string, RegExp, string]> = [
  ['jwt', /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/g, '[redacted:jwt]'],
  ['bearer', /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  [
    'pem',
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '[redacted:pem]',
  ],
  [
    'presign',
    /([?&](?:X-Amz-(?:Signature|Credential|Security-Token)|Signature|Policy|Key-Pair-Id|token|sig)=)[^&\s"'\\]+/gi,
    '$1[redacted]',
  ],
  ['blob', /\b[A-Za-z0-9+/]{200,}={0,2}\b/g, '[redacted:blob]'],
  // Mirrors redactPii in src/untrusted.ts: keep the domain, mask the local part.
  ['email', /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1***@$2'],
];

function scrub(line: string): { text: string; redacted: string[] } {
  let text = line;
  const redacted: string[] = [];
  for (const [label, pattern, replacement] of SCRUBBERS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      pattern.lastIndex = 0;
      text = text.replace(pattern, replacement);
      redacted.push(label);
    }
  }
  return { text, redacted };
}

let cachedVersion: string | undefined;
function pkgVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    cachedVersion = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion ?? 'unknown';
}

function serialise(record: Record<string, unknown>): string {
  const first = JSON.stringify(record);
  const scrubbed = scrub(first);
  let text = scrubbed.text;
  if (scrubbed.redacted.length) {
    text = JSON.stringify({ ...record, redacted: scrubbed.redacted });
    text = scrub(text).text;
  }
  if (Buffer.byteLength(text) <= MAX_LINE_BYTES) return text;

  // Too big: shed the payload, then fall back to the irreducible facts.
  const lean = scrub(JSON.stringify({ ...record, detail: undefined, bodyKeys: undefined, truncated: true })).text;
  if (Buffer.byteLength(lean) <= MAX_LINE_BYTES) return lean;

  return scrub(
    JSON.stringify({
      v: SCHEMA_VERSION,
      ts: record.ts,
      sid: record.sid,
      kind: record.kind,
      status: record.status,
      requestId: record.requestId,
      message: cap(record.message, 200),
      truncated: true,
    })
  ).text;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function maxBytes(): number {
  const raw = Number(process.env.ASC_FAILURE_LOG_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BYTES;
}

/**
 * Rotation is best-effort. `renameSync` is atomic, so the worst outcome when
 * two processes rotate at once is a handful of lines landing in a file that has
 * just been renamed — cheaper than a lock, and triage skips what it cannot parse.
 */
function rotateIfNeeded(dir: string, about: number): void {
  bytesSinceStat += about;
  writesSinceStat += 1;
  const limit = maxBytes();
  if (writesSinceStat < STAT_EVERY && bytesSinceStat < limit) return;
  writesSinceStat = 0;
  bytesSinceStat = 0;

  try {
    const file = path.join(dir, LOG_NAME);
    const size = fs.statSync(file).size;
    if (size < limit) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(file, path.join(dir, `failures-${stamp}.jsonl`));

    const rotated = fs
      .readdirSync(dir)
      .filter((f) => /^failures-.*\.jsonl$/.test(f))
      .sort()
      .reverse();
    for (const stale of rotated.slice(KEEP_ROTATED)) {
      try {
        fs.unlinkSync(path.join(dir, stale));
      } catch {
        /* Housekeeping only. */
      }
    }
  } catch {
    /* A failed rotation must never prevent the append. */
  }
}

/**
 * One buffer, one syscall, O_APPEND. Not `appendFileSync`, which loops on
 * partial writes for large buffers and can interleave with another process.
 * The descriptor is not cached: a long-lived fd survives a rename and keeps
 * writing into the rotated file.
 */
function append(dir: string, line: string): void {
  const buf = Buffer.from(`${line}\n`, 'utf8');
  let fd: number | undefined;
  try {
    fd = fs.openSync(path.join(dir, LOG_NAME), 'a');
    fs.writeSync(fd, buf);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* Already gone. */
      }
    }
  }
  rotateIfNeeded(dir, buf.byteLength);
}

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

function dedupeKey(e: FailureEvent, normalisedPath?: string): string {
  return createHash('sha256')
    .update(`${e.kind}|${e.operationId ?? normalisedPath ?? ''}|${e.status ?? ''}|${e.code ?? ''}|${e.subtype ?? ''}`)
    .digest('hex')
    .slice(0, 12);
}

function repeatLine(dir: string, key: string, entry: DedupeEntry): void {
  if (entry.n <= 1) return;
  const { kind: ofKind, ...seed } = entry.seed;
  const line = serialise({
    v: SCHEMA_VERSION,
    ts: new Date(entry.last).toISOString(),
    sid: sessionId,
    kind: 'repeat',
    ofKind,
    key,
    n: entry.n - 1,
    firstTs: new Date(entry.first).toISOString(),
    ...seed,
    message: `${entry.n - 1} further identical failures within the dedupe window`,
    pkg: pkgVersion(),
  });
  append(dir, line);
}

function sweep(dir: string, now: number): void {
  for (const [key, entry] of seen) {
    if (now - entry.last < DEDUPE_WINDOW_MS) continue;
    repeatLine(dir, key, entry);
    seen.delete(key);
  }
  while (seen.size > DEDUPE_MAX_KEYS) {
    const oldest = seen.keys().next();
    if (oldest.done) break;
    const entry = seen.get(oldest.value);
    if (entry) repeatLine(dir, oldest.value, entry);
    seen.delete(oldest.value);
  }
}

/** Emit any pending repeat summaries. Called on shutdown; safe to call twice. */
export function flushFailureLog(): void {
  if (disabled || seen.size === 0) return;
  try {
    const dir = resolveLogDir();
    if (!dir) {
      seen.clear();
      return;
    }
    for (const [key, entry] of seen) repeatLine(dir, key, entry);
    seen.clear();
  } catch {
    /* Shutdown is not the place to raise. */
  }
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

const RETRY_RESOLUTION = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT']);

/**
 * Record one failure. Never throws, never awaits, never touches stdout.
 *
 * Returns void rather than a promise so a caller cannot accidentally await it
 * or attach a rejection handler to it.
 */
export function recordFailure(event: FailureEvent): void {
  if (disabled || inRecord) return;
  inRecord = true;
  try {
    let dir = resolveLogDir();
    if (!dir) return;

    const ctx = context.getStore();
    const now = Date.now();
    const normalised = normalisePath(event.path);

    sweep(dir, now);

    const key = dedupeKey(event, normalised);
    const existing = seen.get(key);
    if (existing) {
      existing.n += 1;
      existing.last = now;
      return;
    }
    seen.set(key, {
      n: 1,
      first: now,
      last: now,
      seed: {
        kind: event.kind,
        operationId: event.operationId,
        path: normalised,
        status: event.status,
        code: event.code,
      },
    });

    const record: Record<string, unknown> = {
      v: SCHEMA_VERSION,
      ts: new Date(now).toISOString(),
      sid: sessionId,
      source: event.source ?? 'server',
      kind: event.kind,
      tool: event.tool ?? ctx?.tool,
      operationId: event.operationId ?? ctx?.operationId,
      method: event.method,
      path: normalised,
      status: event.status,
      code: event.code,
      requestId: event.requestId,
      ambiguous: event.ambiguous || undefined,
      attempts: event.attempts,
      subtype: event.subtype,
      host: event.host,
      counts: event.counts,
      message: cap(event.message) ?? '',
      detail: reduceDetail(event.detail),
      bodyKeys: event.bodyKeys?.slice(0, MAX_BODY_KEYS),
      note: cap(event.note),
      untrustedNote: event.note ? true : undefined,
      degraded: event.degraded || undefined,
      pkg: pkgVersion(),
      node: process.version,
    };
    for (const [k, v] of Object.entries(record)) if (v === undefined) delete record[k];

    try {
      append(dir, serialise(record));
      consecutiveFailures = 0;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? '';
      // One re-resolution, then give up for good. Never a per-write cascade.
      if (RETRY_RESOLUTION.has(code) && !reResolved) {
        reResolved = true;
        rejectedDirs.push(dir);
        cachedDir = UNRESOLVED;
        dir = resolveLogDir();
        if (dir) {
          append(dir, serialise(record));
          consecutiveFailures = 0;
          return;
        }
      }
      throw error;
    }
  } catch {
    consecutiveFailures += 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      disabled = true;
      warnOnce('failure logging disabled after repeated write errors');
    }
  } finally {
    inRecord = false;
  }
}
