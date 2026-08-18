#!/usr/bin/env node
/**
 * Verify both APIs against reality rather than against the description.
 *
 * Three things are checked, because they fail independently:
 *
 *   1. Drift — the StoreKit catalogue in src/storekit.ts against the endpoint
 *      set parsed from Apple's own client. Catches a path that Apple changed
 *      or that was transcribed wrong.
 *   2. App Store Connect — real authenticated calls against live endpoints.
 *   3. App Store Server — a real call proving host, `bid` claim and routing.
 *      Without a known transaction ID the useful signal is the *shape of the
 *      failure*: Apple's structured 404 (errorCode 4040010) proves the request
 *      was authenticated and routed, where a 401 would prove it was not.
 *
 * Read-only throughout. Nothing here mutates an account.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { resolveCredentials } = await import(path.join(ROOT, 'dist/credentials.js'));
const { TokenMinter } = await import(path.join(ROOT, 'dist/jwt.js'));
const { ApiClient, ApiError, renderPath } = await import(path.join(ROOT, 'dist/http.js'));
const { STOREKIT_OPERATIONS, STOREKIT_HOSTS } = await import(path.join(ROOT, 'dist/storekit.js'));
const { loadIndex, findOperation } = await import(path.join(ROOT, 'dist/spec.js'));

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); pass += 1; };
const bad = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); fail += 1; };

// ---------------------------------------------------------------------------
console.log('\n\x1b[1m1. Catalogue drift — src/storekit.ts vs Apple’s client\x1b[0m');
// ---------------------------------------------------------------------------
const parsedFile = path.join(ROOT, 'spec/storekit-endpoints.json');
if (!fs.existsSync(parsedFile)) {
  bad('spec/storekit-endpoints.json missing — run: node scripts/fetch-specs.mjs');
} else {
  const parsed = JSON.parse(fs.readFileSync(parsedFile, 'utf8'));
  console.log(`  source: ${parsed.source}`);

  // Compare path SHAPE, not placeholder names: Apple's client calls the first
  // segment `anyTransactionId` where the catalogue calls it `transactionId`.
  // The name is ours to choose; the structure is Apple's to dictate.
  const norm = (s) => s.replace(/\{[^}]+\}/g, '{}');
  const theirs = new Set(parsed.operations.map((o) => `${o.method} ${norm(o.path)}`));
  const ours = new Set(STOREKIT_OPERATIONS.map((o) => `${o.method} ${norm(o.path)}`));

  const missing = [...theirs].filter((x) => !ours.has(x));
  const extra = [...ours].filter((x) => !theirs.has(x));

  if (!missing.length) ok(`all ${theirs.size} Apple endpoints present in the catalogue`);
  else missing.forEach((m) => bad(`missing from src/storekit.ts: ${m}`));

  if (!extra.length) ok('no endpoints in the catalogue that Apple does not define');
  else extra.forEach((m) => bad(`not in Apple’s client: ${m}`));
}

// ---------------------------------------------------------------------------
console.log('\n\x1b[1m2. App Store Connect API — live\x1b[0m');
// ---------------------------------------------------------------------------
const creds = resolveCredentials({
  keyRef: process.env.ASC_KEY ?? 'keychain:prayertimes-asc',
  issuerId: process.env.ASC_ISSUER_ID,
  keyId: process.env.ASC_KEY_ID,
});
console.log(`  key: ${creds.source}  keyId=${creds.keyId}`);

const bundleId = process.env.ASC_BUNDLE_ID ?? 'dev.abd3lraouf.PrayerTimes';
const minter = new TokenMinter(creds, bundleId);
const client = new ApiClient(minter);
const index = loadIndex();

async function connectCall(operationId, { path_params = {}, query } = {}) {
  const op = findOperation(operationId);
  if (!op) throw new Error(`operationId not in index: ${operationId}`);
  return client.request({
    baseUrl: index.baseUrl,
    method: op.method,
    path: renderPath(op.path, path_params),
    query,
    audience: 'connect',
  });
}

let anyAppId;
try {
  const r = await connectCall('apps_getCollection', { query: { limit: 5, 'fields[apps]': 'name,bundleId,sku' } });
  const apps = r.data.data ?? [];
  ok(`apps_getCollection → ${apps.length} apps: ${apps.map((a) => a.attributes.bundleId).join(', ')}`);
  anyAppId = apps[0]?.id;
} catch (e) {
  bad(`apps_getCollection failed: ${e.message}`);
}

// Exercise the index end to end: an operationId picked out of the spec, with a
// path parameter, proving templates render and parameters are accepted.
if (anyAppId) {
  for (const [operationId, query] of [
    ['apps_getInstance', { 'fields[apps]': 'name,bundleId' }],
    ['apps_builds_getToManyRelated', { limit: 3, 'fields[builds]': 'version,uploadedDate' }],
    ['apps_appStoreVersions_getToManyRelated', { limit: 3, 'fields[appStoreVersions]': 'versionString,appStoreState' }],
  ]) {
    try {
      const r = await connectCall(operationId, { path_params: { id: anyAppId }, query });
      const n = Array.isArray(r.data.data) ? r.data.data.length : 1;
      ok(`${operationId} → HTTP ${r.status}, ${n} record(s)`);
    } catch (e) {
      bad(`${operationId} failed: ${e.message}`);
    }
  }
}

// Pagination: ask for a page size of 1 and confirm the walker follows links.next.
try {
  const op = findOperation('apps_getCollection');
  const r = await client.requestAll(
    { baseUrl: index.baseUrl, method: op.method, path: op.path, query: { limit: 1 }, audience: 'connect' },
    3
  );
  ok(`pagination walked ${r.data.pages} page(s), ${r.data.count} item(s) collected`);
} catch (e) {
  bad(`pagination failed: ${e.message}`);
}

// A wrong ID must surface as Apple's structured error, not a thrown mess.
try {
  await connectCall('apps_getInstance', { path_params: { id: '0000000000' } });
  bad('expected a 404 for a bogus app id, got success');
} catch (e) {
  if (e instanceof ApiError && e.status === 404) ok(`bogus id → structured 404: ${e.message.slice(0, 70)}`);
  else bad(`unexpected error shape: ${e.message}`);
}

// ---------------------------------------------------------------------------
console.log('\n\x1b[1m3. App Store Server API (StoreKit 2) — live\x1b[0m');
// ---------------------------------------------------------------------------
const env = process.env.ASC_STOREKIT_ENV === 'Sandbox' ? 'Sandbox' : 'Production';
const host = STOREKIT_HOSTS[env];
console.log(`  host: ${host}   bundleId: ${bundleId}`);

// The bid claim is what separates a Server API token from a Connect token.
try {
  const decoded = JSON.parse(Buffer.from(minter.mint('storekit').split('.')[1], 'base64url').toString());
  if (decoded.bid === bundleId) ok(`storekit token carries bid=${decoded.bid}`);
  else bad(`storekit token bid is ${decoded.bid}, expected ${bundleId}`);
  const connectClaims = JSON.parse(Buffer.from(minter.mint('connect').split('.')[1], 'base64url').toString());
  if (connectClaims.bid === undefined) ok('connect token correctly omits bid');
  else bad('connect token should not carry bid');
} catch (e) {
  bad(`token inspection failed: ${e.message}`);
}

// Reaching Apple's application layer at all is the thing being proven here.
// 401 => host or credentials wrong. A structured Apple errorCode => correct.
async function storekitProbe(label, opId, pathParams, query) {
  const op = STOREKIT_OPERATIONS.find((o) => o.id === opId);
  try {
    const r = await client.request({
      baseUrl: host,
      method: op.method,
      path: renderPath(op.path, pathParams),
      query,
      audience: 'storekit',
    });
    ok(`${label} → HTTP ${r.status} (live data returned)`);
    return r;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      bad(`${label} → 401 UNAUTHENTICATED. Host/JWT/bid wrong, or the key lacks Server API access.`);
    } else if (e instanceof ApiError && e.detail && typeof e.detail === 'object' && 'errorCode' in e.detail) {
      ok(`${label} → authenticated and routed; Apple replied ${e.status} errorCode ${e.detail.errorCode} (${e.detail.errorMessage})`);
    } else if (e instanceof ApiError) {
      bad(`${label} → HTTP ${e.status}, unrecognised body: ${JSON.stringify(e.detail).slice(0, 160)}`);
    } else {
      bad(`${label} → ${e.message}`);
    }
    return undefined;
  }
}

// A syntactically valid but non-existent transaction id: proves routing and
// auth without needing a real customer transaction.
await storekitProbe('getTransactionInfo (bogus id)', 'storekit_getTransactionInfo', { transactionId: '000000000000000' });
await storekitProbe('getAllSubscriptionStatuses (bogus id)', 'storekit_getAllSubscriptionStatuses', { transactionId: '000000000000000' });
await storekitProbe('getTransactionHistory v2 (bogus id)', 'storekit_getTransactionHistory', { version: 'v2', transactionId: '000000000000000' });

// A genuine read against live account data. This one needs a body: Apple
// requires an explicit window, and rejects ranges wider than 180 days.
{
  const endDate = Date.now() - 60_000; // Apple rejects an endDate in the future.
  const startDate = endDate - 30 * 24 * 60 * 60 * 1000;
  const op = STOREKIT_OPERATIONS.find((o) => o.id === 'storekit_getNotificationHistory');
  try {
    const r = await client.request({
      baseUrl: host,
      method: op.method,
      path: op.path,
      body: { startDate, endDate },
      audience: 'storekit',
    });
    const n = r.data?.notificationHistory?.length ?? 0;
    ok(`getNotificationHistory (30d window) → HTTP ${r.status}, ${n} notification(s)`);
  } catch (e) {
    if (e instanceof ApiError && e.detail && typeof e.detail === 'object' && 'errorCode' in e.detail) {
      ok(`getNotificationHistory → authenticated; Apple replied ${e.status} errorCode ${e.detail.errorCode} (${e.detail.errorMessage})`);
    } else {
      bad(`getNotificationHistory → HTTP ${e.status ?? '?'}: ${JSON.stringify(e.detail ?? e.message).slice(0, 200)}`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log(`\n\x1b[1mResult: ${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
