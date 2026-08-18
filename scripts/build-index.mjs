#!/usr/bin/env node
/**
 * Compile Apple's OpenAPI document into a slim operation index.
 *
 * The full spec is ~6.8MB. Loading it to answer "which endpoints mention
 * subscriptions?" is wasteful, so search runs against this index (~10% the
 * size) and the full document is opened lazily, only when a caller asks to
 * describe one operation in detail.
 *
 * Risk classification happens here rather than at request time so that the
 * safety gate and the tool descriptions can never disagree about what a given
 * operation does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SPEC = path.join(ROOT, 'spec', 'apple-openapi.json');
const OUT = path.join(ROOT, 'spec', 'index.json');

const METHODS = ['get', 'post', 'patch', 'put', 'delete'];

/**
 * Risk tiers, ordered least to most consequential. Anything above WRITE is
 * gated by default because the HTTP method alone does not convey the damage:
 * a PATCH can drop a price worldwide, and that is not recoverable by re-PATCHing.
 */
const RISK = {
  READ: 'READ',
  WRITE: 'WRITE',
  RELEASE: 'RELEASE',
  REVENUE: 'REVENUE',
  INFRASTRUCTURE: 'INFRASTRUCTURE',
  ACCESS: 'ACCESS',
  DESTRUCTIVE: 'DESTRUCTIVE',
};

// Ordered: first match wins, so put the sharpest patterns first.
const RISK_RULES = [
  [/price|pricePoint|priceSchedule|subscriptionPrice|iap|inAppPurchase|subscription/i, RISK.REVENUE],
  [/users|userInvitations|roles|betaTesters|betaGroups/i, RISK.ACCESS],
  [/certificates|profiles|bundleIds|devices|merchantIds|passTypeIds/i, RISK.INFRASTRUCTURE],
  [/appStoreVersionReleaseRequest|phasedRelease|submissions|reviewSubmissions|builds/i, RISK.RELEASE],
];

function classify(method, p) {
  if (method === 'get') return RISK.READ;
  if (method === 'delete') return RISK.DESTRUCTIVE;
  for (const [re, level] of RISK_RULES) if (re.test(p)) return level;
  return RISK.WRITE;
}

/** Resolve a local $ref one level; enough to name a request body schema. */
function refName(ref) {
  return typeof ref === 'string' ? ref.split('/').pop() : undefined;
}

function bodySchemaName(op) {
  const content = op.requestBody?.content?.['application/json'];
  if (!content?.schema) return undefined;
  return refName(content.schema.$ref) ?? undefined;
}

const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
const operations = [];

for (const [p, item] of Object.entries(spec.paths)) {
  // Path-level parameters apply to every operation underneath.
  const shared = Array.isArray(item.parameters) ? item.parameters : [];

  for (const method of METHODS) {
    const op = item[method];
    if (!op) continue;

    const params = [...shared, ...(op.parameters ?? [])];
    const pathParams = params.filter((x) => x.in === 'path').map((x) => x.name);
    const queryParams = params.filter((x) => x.in === 'query').map((x) => x.name);

    // Apple encodes path params as {id}; keep them even when undeclared.
    for (const m of p.matchAll(/\{([^}]+)\}/g)) {
      if (!pathParams.includes(m[1])) pathParams.push(m[1]);
    }

    operations.push({
      id: op.operationId ?? `${method}:${p}`,
      method: method.toUpperCase(),
      path: p,
      tags: op.tags ?? [],
      summary: op.summary ?? op.description?.split('\n')[0] ?? '',
      pathParams,
      queryParams,
      body: bodySchemaName(op),
      risk: classify(method, p),
    });
  }
}

operations.sort((a, b) => a.id.localeCompare(b.id));

const byRisk = {};
for (const o of operations) byRisk[o.risk] = (byRisk[o.risk] ?? 0) + 1;

// Enum tables, generated rather than written down.
//
// A hand-maintained enum table is a table that goes stale: one competitor's
// cookbook lists an eventState value Apple does not have and omits two it does.
// Deriving them from the spec makes that class of error impossible.
const enums = {};
for (const [schemaName, schema] of Object.entries(spec.components?.schemas ?? {})) {
  const attrs = schema?.properties?.attributes?.properties;
  if (!attrs) continue;
  for (const [field, def] of Object.entries(attrs)) {
    if (Array.isArray(def.enum) && def.enum.length) {
      enums[`${schemaName}.${field}`] = def.enum;
    }
  }
}
fs.writeFileSync(
  path.join(ROOT, 'spec', 'enums.json'),
  JSON.stringify({ apiVersion: spec.info.version, count: Object.keys(enums).length, enums }, null, 2)
);

const index = {
  apiVersion: spec.info.version,
  title: spec.info.title,
  baseUrl: spec.servers?.[0]?.url?.replace(/\/$/, '') ?? 'https://api.appstoreconnect.apple.com',
  generatedFrom: 'spec/apple-openapi.json',
  pathCount: Object.keys(spec.paths).length,
  operationCount: operations.length,
  byRisk,
  operations,
};

fs.writeFileSync(OUT, JSON.stringify(index));
const kb = (n) => `${Math.round(n / 1024)}KB`;
console.log(
  `spec index: ${operations.length} operations from ${index.pathCount} paths ` +
    `(API v${index.apiVersion}) — ${kb(fs.statSync(OUT).size)} vs ${kb(fs.statSync(SPEC).size)} full`
);
console.log('risk mix:', byRisk);
console.log(`enum tables: ${Object.keys(enums).length} → spec/enums.json`);
