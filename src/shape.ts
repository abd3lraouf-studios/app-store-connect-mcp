/**
 * Trimming Apple's responses down to the part that carries information.
 *
 * JSON:API is verbose in a way that is expensive for a model: every resource
 * carries a `links.self`, and every relationship that holds no data still
 * carries a `links` pair repeating the parent's id in URL form. On a price-point
 * listing the ratio is roughly ten to one — bytes that cost context and say
 * nothing the `id` and `type` fields have not already said.
 *
 * `links.next` is the exception and is always preserved: dropping it would
 * silently break pagination.
 */

const PAGINATION_KEYS = new Set(['next']);

function shapeLinks(links: unknown): unknown {
  if (!links || typeof links !== 'object') return undefined;
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(links as Record<string, unknown>)) {
    if (PAGINATION_KEYS.has(k)) kept[k] = v;
  }
  return Object.keys(kept).length ? kept : undefined;
}

/**
 * A relationship is worth keeping only if it carries `data`. One that holds
 * nothing but `links` is a URL the caller can reconstruct from the parent id.
 */
function shapeRelationships(rels: unknown): unknown {
  if (!rels || typeof rels !== 'object') return undefined;
  const kept: Record<string, unknown> = {};
  for (const [name, rel] of Object.entries(rels as Record<string, any>)) {
    if (rel && typeof rel === 'object' && 'data' in rel && rel.data !== undefined && rel.data !== null) {
      kept[name] = { data: rel.data };
    }
  }
  return Object.keys(kept).length ? kept : undefined;
}

function shapeNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(shapeNode);
  if (!node || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'links') {
      const links = shapeLinks(value);
      if (links) out.links = links;
      continue;
    }
    if (key === 'relationships') {
      const rels = shapeRelationships(value);
      if (rels) out.relationships = rels;
      continue;
    }
    out[key] = shapeNode(value);
  }
  return out;
}

/**
 * @param enabled false returns the payload untouched (`ASC_KEEP_RAW=1`).
 */
export function shapeResponse(payload: unknown, enabled = true): unknown {
  return enabled ? shapeNode(payload) : payload;
}

/** Rough proxy for token cost; exact enough to decide whether to truncate. */
export function approximateChars(value: unknown): number {
  return typeof value === 'string' ? value.length : JSON.stringify(value ?? null).length;
}
