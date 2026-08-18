/**
 * Shared machinery for the composite tools.
 *
 * A macro earns its place only when the raw API cannot express the task in one
 * call — a multi-hop chain, a sequence across two hosts, or a format the caller
 * would otherwise have to decode themselves. Anything that merely saves one
 * request belongs in `asc_call`, where it costs no maintenance.
 */
import type { ApiClient } from '../http.js';

export interface MacroContext {
  client: ApiClient;
  /** https://api.appstoreconnect.apple.com */
  baseUrl: string;
}

/** A GET against App Store Connect, returning the parsed JSON:API body. */
export async function get(
  ctx: MacroContext,
  path: string,
  query?: Record<string, unknown>
): Promise<any> {
  const res = await ctx.client.request({
    baseUrl: ctx.baseUrl,
    method: 'GET',
    path,
    query,
    audience: 'connect',
  });
  return res.data;
}

/** Follow `links.next` and return every row, not just the first page. */
export async function getAll(
  ctx: MacroContext,
  path: string,
  query?: Record<string, unknown>,
  maxPages = 20
): Promise<any[]> {
  const res = await ctx.client.requestAll(
    { baseUrl: ctx.baseUrl, method: 'GET', path, query, audience: 'connect' },
    maxPages
  );
  return (res.data as any).items ?? [];
}

/**
 * Accept whatever the user has to hand.
 *
 * People refer to an app by its bundle ID, its store name, or the numeric
 * Apple ID, and which one they have depends on where they were looking.
 * Making every macro accept all three removes a lookup step that otherwise
 * costs a round trip and an easy mistake.
 */
export async function resolveApp(
  ctx: MacroContext,
  app: string
): Promise<{ id: string; bundleId: string; name: string }> {
  const fields = { 'fields[apps]': 'name,bundleId' };

  // A bare number is an Apple ID; fetch it directly.
  if (/^\d+$/.test(app)) {
    const body = await get(ctx, `/v1/apps/${app}`, fields);
    return { id: body.data.id, bundleId: body.data.attributes.bundleId, name: body.data.attributes.name };
  }

  const filterKey = app.includes('.') ? 'filter[bundleId]' : 'filter[name]';
  const body = await get(ctx, '/v1/apps', { ...fields, [filterKey]: app, limit: 10 });
  const matches = body.data ?? [];

  if (!matches.length) {
    // Fall back to the other filter before giving up — a name can contain a
    // dot, and a bundle ID fragment can look like a name.
    const other = app.includes('.') ? 'filter[name]' : 'filter[bundleId]';
    const retry = await get(ctx, '/v1/apps', { ...fields, [other]: app, limit: 10 });
    if (!retry.data?.length) {
      throw new Error(
        `No app matched "${app}". Try the exact bundle ID, the store name, or the numeric Apple ID. ` +
          `asc_call apps_getCollection lists everything this key can see.`
      );
    }
    matches.push(...retry.data);
  }

  if (matches.length > 1) {
    throw new Error(
      `"${app}" matched ${matches.length} apps: ` +
        matches.map((m: any) => `${m.attributes.bundleId} (${m.id})`).join(', ') +
        '. Use the bundle ID or the numeric Apple ID.'
    );
  }

  const hit = matches[0];
  return { id: hit.id, bundleId: hit.attributes.bundleId, name: hit.attributes.name };
}

/** Index an `included` array by "type:id" for cheap lookups. */
export function indexIncluded(body: any): Map<string, any> {
  const map = new Map<string, any>();
  for (const item of body?.included ?? []) map.set(`${item.type}:${item.id}`, item);
  return map;
}
