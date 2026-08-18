/**
 * Resources: reference material the model can read on demand, and a place to
 * put results that are too large to return inline.
 *
 * Claude Code exposes these as `@asc:` references, so the cookbook and the
 * generated enum tables become things a user can pull into context
 * deliberately rather than material we push into every tool description.
 *
 * The overflow store solves the other half. A large collection cannot simply
 * be cut off: truncating JSON mid-structure hands the model something
 * unparseable, and cutting silently is worse still because a partial list
 * reads as a complete one. Instead the array is trimmed to what fits, the
 * truncation is stated, and the full text is kept here under an
 * `asc-response://` URI the client can read without spending context.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { RISK_EXPLANATION } from './safety.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

export const OVERFLOW_SCHEME = 'asc-response://';

/** Bounded so a long session cannot grow the process without limit. */
const MAX_ENTRIES = 20;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

interface StoredResponse {
  uri: string;
  text: string;
  tool: string;
  bytes: number;
}

/** Least-recently-stored eviction; entries are write-once. */
export class ResponseStore {
  private entries = new Map<string, StoredResponse>();
  private bytes = 0;

  store(tool: string, text: string): string {
    const uri = `${OVERFLOW_SCHEME}${randomUUID()}/${tool}.json`;
    const entry: StoredResponse = { uri, text, tool, bytes: Buffer.byteLength(text) };
    this.entries.set(uri, entry);
    this.bytes += entry.bytes;
    this.evict();
    return uri;
  }

  get(uri: string): StoredResponse | undefined {
    return this.entries.get(uri);
  }

  list(): StoredResponse[] {
    return [...this.entries.values()];
  }

  private evict(): void {
    while (this.entries.size > MAX_ENTRIES || this.bytes > MAX_TOTAL_BYTES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      const entry = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      this.bytes -= entry?.bytes ?? 0;
    }
  }
}

function readOptional(relative: string): string | undefined {
  const file = path.join(ROOT, relative);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
}

export interface StaticResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read: () => string;
}

export function staticResources(): StaticResource[] {
  const resources: StaticResource[] = [
    {
      uri: 'asc://risk',
      name: 'Risk tiers',
      description:
        'What each risk tier means and how reversible it is. Read before asking a user to approve a write.',
      mimeType: 'application/json',
      read: () => JSON.stringify(RISK_EXPLANATION, null, 2),
    },
  ];

  const cookbook = readOptional('docs/COOKBOOK.md');
  if (cookbook) {
    resources.push({
      uri: 'asc://cookbook',
      name: 'Apple API pitfalls',
      description:
        'Cases where Apple returns a successful response that means something other than it appears to — ' +
        'pagination, alpha-3 territories, rejected sort, gzipped reports. Read before interpreting an empty result.',
      mimeType: 'text/markdown',
      read: () => cookbook,
    });
  }

  const enums = readOptional('spec/enums.json');
  if (enums) {
    resources.push({
      uri: 'asc://enums',
      name: 'Enum values',
      description:
        'Every enumerated field in the App Store Connect API, generated from Apple’s own spec so it cannot go stale.',
      mimeType: 'application/json',
      read: () => enums,
    });
  }

  const sources = readOptional('spec/sources.json');
  if (sources) {
    resources.push({
      uri: 'asc://sources',
      name: 'Spec provenance',
      description: 'Where each API description came from and when it was fetched.',
      mimeType: 'application/json',
      read: () => sources,
    });
  }

  return resources;
}
