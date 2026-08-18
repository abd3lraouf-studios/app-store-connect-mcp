/**
 * The App Store Connect operation catalogue, compiled from Apple's own
 * OpenAPI document by scripts/build-index.mjs.
 *
 * Search runs against a slim index (~360KB). The full 7MB document is opened
 * lazily and only when a caller describes a single operation, which keeps
 * startup fast and steady-state memory small.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Risk } from './safety.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC_DIR = path.join(HERE, '..', 'spec');

export interface Operation {
  id: string;
  method: string;
  path: string;
  tags: string[];
  summary: string;
  pathParams: string[];
  queryParams: string[];
  body?: string;
  risk: Risk;
}

interface SpecIndex {
  apiVersion: string;
  title: string;
  baseUrl: string;
  pathCount: number;
  operationCount: number;
  byRisk: Record<string, number>;
  operations: Operation[];
}

let index: SpecIndex | undefined;
let fullSpec: any | undefined;

export function loadIndex(): SpecIndex {
  if (index) return index;
  const file = path.join(SPEC_DIR, 'index.json');
  if (!fs.existsSync(file)) {
    throw new Error(`Spec index missing at ${file}. Run: npm run build:index`);
  }
  index = JSON.parse(fs.readFileSync(file, 'utf8')) as SpecIndex;
  return index;
}

function loadFullSpec(): any {
  if (fullSpec) return fullSpec;
  fullSpec = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, 'apple-openapi.json'), 'utf8'));
  return fullSpec;
}

let byId: Map<string, Operation> | undefined;

export function findOperation(id: string): Operation | undefined {
  if (!byId) byId = new Map(loadIndex().operations.map((o) => [o.id, o]));
  return byId.get(id);
}

export interface SearchArgs {
  query?: string;
  method?: string;
  tag?: string;
  risk?: Risk;
  limit?: number;
}

/**
 * Rank matches so the obvious answer surfaces first: an exact operationId beats
 * a path hit, which beats a summary hit. Without this, searching "apps" buries
 * `apps_getCollection` under a hundred nested relationship endpoints.
 */
export function searchOperations(args: SearchArgs): { total: number; results: Operation[] } {
  const { operations } = loadIndex();
  const q = args.query?.toLowerCase().trim();
  const method = args.method?.toUpperCase();

  const scored: Array<{ op: Operation; score: number }> = [];

  for (const op of operations) {
    if (method && op.method !== method) continue;
    if (args.risk && op.risk !== args.risk) continue;
    if (args.tag && !op.tags.some((t) => t.toLowerCase() === args.tag!.toLowerCase())) continue;

    let score = 0;
    if (!q) {
      score = 1;
    } else {
      const id = op.id.toLowerCase();
      const p = op.path.toLowerCase();
      const summary = op.summary.toLowerCase();
      const tags = op.tags.join(' ').toLowerCase();

      if (id === q) {
        score = 100;
      } else {
        // Match term by term, not as one phrase. Apple's identifiers are
        // camelCase and its paths are slash-separated, so a natural query like
        // "subscription price" never appears literally in "subscriptionPrices"
        // — every term has to be found somewhere for the operation to count.
        const terms = q.split(/\s+/).filter(Boolean);
        let total = 0;
        for (const term of terms) {
          let best = 0;
          if (id.includes(term)) best = 50;
          else if (p.includes(term)) best = 30;
          else if (tags.includes(term)) best = 20;
          else if (summary.includes(term)) best = 10;
          if (best === 0) {
            total = 0;
            break; // Every term must land somewhere.
          }
          total += best;
        }
        score = terms.length ? total / terms.length : 0;
      }

      // Prefer shallow paths: /v1/apps over /v1/apps/{id}/relationships/…
      if (score > 0) score -= Math.min(9, (op.path.match(/\//g)?.length ?? 0));
    }

    if (score > 0) scored.push({ op, score });
  }

  scored.sort((a, b) => b.score - a.score || a.op.id.localeCompare(b.op.id));
  const limit = Math.min(args.limit ?? 25, 200);
  return { total: scored.length, results: scored.slice(0, limit).map((s) => s.op) };
}

/** Full detail for one operation, including parameter and body schemas. */
export function describeOperation(id: string): Record<string, unknown> {
  const op = findOperation(id);
  if (!op) throw new Error(`Unknown operationId "${id}". Use asc_search_endpoints to find it.`);

  const spec = loadFullSpec();
  const item = spec.paths[op.path];
  const raw = item?.[op.method.toLowerCase()];

  const parameters = [...(item?.parameters ?? []), ...(raw?.parameters ?? [])].map((p: any) => ({
    name: p.name,
    in: p.in,
    required: p.required ?? p.in === 'path',
    description: p.description,
    schema: p.schema,
  }));

  // Resolve the request body one level so the caller sees real field names
  // rather than a $ref they cannot follow.
  let requestBody: unknown;
  const ref = raw?.requestBody?.content?.['application/json']?.schema?.$ref;
  if (ref) {
    const name = ref.split('/').pop() as string;
    requestBody = { schema: name, definition: spec.components?.schemas?.[name] };
  }

  return {
    operationId: op.id,
    method: op.method,
    path: op.path,
    tags: op.tags,
    summary: op.summary,
    risk: op.risk,
    pathParams: op.pathParams,
    parameters,
    requestBody,
    responses: raw?.responses ? Object.keys(raw.responses) : [],
  };
}
