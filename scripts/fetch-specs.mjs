#!/usr/bin/env node
/**
 * Pull both API descriptions straight from Apple, so refreshing coverage is a
 * command rather than a transcription exercise.
 *
 * The two APIs have to be sourced differently, and it is worth being explicit
 * about why:
 *
 *   App Store Connect — Apple publishes a real OpenAPI 3.0 document. Download
 *   the zip, take the JSON out of it, done.
 *
 *   App Store Server (StoreKit 2) — Apple publishes NO OpenAPI document for
 *   this API; the documentation is prose only. The authoritative machine-
 *   readable description is Apple's own client, app-store-server-library-node,
 *   where every endpoint appears as a literal makeRequest(...) call. So the
 *   catalogue is parsed out of that source, pinned to a release tag. This is
 *   the same thing a human would do by hand, except it can be re-run and it
 *   cannot typo a path.
 *
 * Usage:  node scripts/fetch-specs.mjs [--storekit-ref <git-tag>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SPEC_DIR = path.join(ROOT, 'spec');

const ASC_SPEC_URL =
  'https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip';
const STOREKIT_REPO = 'apple/app-store-server-library-node';
const APPLE_ROOT_CA_URL = 'https://www.apple.com/certificateauthority/AppleRootCA-G3.cer';

const argRef = process.argv.indexOf('--storekit-ref');
const STOREKIT_REF = argRef !== -1 ? process.argv[argRef + 1] : undefined;

fs.mkdirSync(SPEC_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 1. App Store Connect — official OpenAPI document
// ---------------------------------------------------------------------------
function fetchConnectSpec() {
  const zip = path.join(SPEC_DIR, '.asc-spec.zip');
  const tmp = path.join(SPEC_DIR, '.asc-extract');

  console.log(`→ App Store Connect spec: ${ASC_SPEC_URL}`);
  execFileSync('curl', ['-sSL', '--fail', '-o', zip, ASC_SPEC_URL], { stdio: ['ignore', 'inherit', 'inherit'] });

  fs.rmSync(tmp, { recursive: true, force: true });
  execFileSync('unzip', ['-o', '-q', zip, '-d', tmp]);

  // Apple's zip has carried names like "openapi.oas (2).json"; do not rely on it.
  const found = fs
    .readdirSync(tmp, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.json') && !f.includes('__MACOSX'));
  if (!found.length) throw new Error('No JSON document inside Apple’s spec archive.');

  const src = path.join(tmp, found[0]);
  const dest = path.join(SPEC_DIR, 'apple-openapi.json');
  const spec = JSON.parse(fs.readFileSync(src, 'utf8'));
  fs.writeFileSync(dest, JSON.stringify(spec));

  fs.rmSync(zip, { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(
    `  ${spec.info.title} v${spec.info.version} — ${Object.keys(spec.paths).length} paths ` +
      `(from "${found[0]}")`
  );
  return spec.info.version;
}

// ---------------------------------------------------------------------------
// 2. App Store Server API — parsed from Apple's own client
// ---------------------------------------------------------------------------
function resolveStoreKitRef() {
  if (STOREKIT_REF) return STOREKIT_REF;
  const out = execFileSync('gh', ['api', `repos/${STOREKIT_REPO}/releases/latest`, '--jq', '.tag_name'], {
    encoding: 'utf8',
  }).trim();
  return out || 'main';
}

function fetchStoreKitCatalogue() {
  const ref = resolveStoreKitRef();
  const url = `https://raw.githubusercontent.com/${STOREKIT_REPO}/${ref}/index.ts`;
  console.log(`→ App Store Server API: parsing ${STOREKIT_REPO}@${ref}`);

  const source = execFileSync('curl', ['-sSL', '--fail', url], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

  // Each endpoint is one makeRequest call. Paths are built by string
  // concatenation with the argument names, e.g.
  //   "/inApps/v1/subscriptions/" + anyTransactionId
  // which converts cleanly to a {placeholder} template.
  const callRe =
    /this\.makeRequest(?:<[^>]*>)?\(\s*([\s\S]*?),\s*"(GET|POST|PUT|DELETE)"\s*,\s*([\s\S]*?)\s*\)\s*;/g;

  const operations = [];
  const seen = new Set();

  for (const m of source.matchAll(callRe)) {
    const [, pathExpr, method, rest] = m;

    // Turn `"/a/" + x + "/b"` into `/a/{x}/b`.
    let template = '';
    const tokenRe = /"([^"]*)"|([A-Za-z_$][\w$]*)/g;
    for (const t of pathExpr.matchAll(tokenRe)) {
      if (t[1] !== undefined) template += t[1];
      else if (t[2] !== undefined) template += `{${t[2]}}`;
    }
    if (!template.startsWith('/inApps')) continue;

    const pathParams = [...template.matchAll(/\{([^}]+)\}/g)].map((x) => x[1]);
    const key = `${method} ${template}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Trailing args: queryParameters, requestBody, validator, contentType.
    const contentType = /'([a-z]+\/[a-z+-]+)'/.exec(rest)?.[1];

    operations.push({
      method,
      path: template,
      pathParams,
      contentType: contentType && contentType !== 'application/json' ? contentType : undefined,
      // Body presence is confirmed against the hand-maintained catalogue in
      // src/storekit.ts; this file's job is to prove the path set matches.
    });
  }

  operations.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));

  const out = { source: `${STOREKIT_REPO}@${ref}`, fetchedFrom: url, operationCount: operations.length, operations };
  fs.writeFileSync(path.join(SPEC_DIR, 'storekit-endpoints.json'), JSON.stringify(out, null, 2));
  console.log(`  ${operations.length} endpoints parsed → spec/storekit-endpoints.json`);
  return out;
}

/**
 * The trust anchor for App Store Server API responses.
 *
 * Every StoreKit payload is a JWS whose x5c chain roots here. Without this
 * certificate the signatures can only be decoded, not verified — which means
 * trusting whatever the transport handed us. It is vendored rather than
 * fetched at runtime so verification cannot be disabled by a network failure,
 * and refreshed by this script so the provenance is auditable.
 */
function fetchAppleRootCertificate() {
  console.log(`→ Apple Root CA - G3: ${APPLE_ROOT_CA_URL}`);
  const dest = path.join(ROOT, 'certs', 'AppleRootCA-G3.cer');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  execFileSync('curl', ['-sSL', '--fail', '-o', dest, APPLE_ROOT_CA_URL]);

  const subject = execFileSync('openssl', ['x509', '-inform', 'DER', '-in', dest, '-noout', '-subject'], {
    encoding: 'utf8',
  }).trim();
  if (!subject.includes('Apple Root CA - G3')) {
    throw new Error(`Downloaded certificate is not Apple Root CA - G3: ${subject}`);
  }
  const notAfter = execFileSync('openssl', ['x509', '-inform', 'DER', '-in', dest, '-noout', '-enddate'], {
    encoding: 'utf8',
  }).trim();
  console.log(`  ${subject.replace('subject=', '')}`);
  console.log(`  ${notAfter}`);
  return { subject, notAfter };
}

const ascVersion = fetchConnectSpec();
const storekit = fetchStoreKitCatalogue();
const rootCa = fetchAppleRootCertificate();

fs.writeFileSync(
  path.join(SPEC_DIR, 'sources.json'),
  JSON.stringify(
    {
      fetchedAt: new Date().toISOString(),
      appStoreConnect: { url: ASC_SPEC_URL, apiVersion: ascVersion },
      appStoreServer: { source: storekit.source, note: 'Apple publishes no OpenAPI document for this API.' },
      appleRootCertificate: { url: APPLE_ROOT_CA_URL, subject: rootCa.subject, notAfter: rootCa.notAfter },
    },
    null,
    2
  )
);

console.log('\nNext: npm run build:index && npm run verify');
