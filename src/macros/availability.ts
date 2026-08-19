/**
 * Store availability, per territory.
 *
 * Taking an app off sale or putting it back is the highest-consequence routine
 * operation on an account, and Apple gives it no bulk endpoint:
 * `appAvailabilities` answers `403 … does not allow 'UPDATE'` once the record
 * exists, so the only route is one PATCH per territory — 175 of them for a
 * worldwide app.
 *
 * Doing that by hand is where the failures live. A loop that stops on the first
 * error leaves the store half-switched with nothing recording how far it got,
 * and a loop that finishes is still not proof: a hand-rolled one silently
 * skipped a territory and read as complete, because nothing compared the result
 * against the request. So this macro reports every operation, keeps going past
 * a failure, and then re-reads all of it and says whether the store actually
 * matches what was asked for.
 */
import { getAllWithIncluded, resolveApp, type MacroContext } from './support.js';
import { ApiError } from '../http.js';

interface Operation {
  territory: string;
  from: boolean;
  to: boolean;
  status: 'changed' | 'unchanged' | 'failed';
  error?: string;
  /** The write may still have landed: a timed-out PATCH is never retried. */
  ambiguous?: boolean;
  httpStatus?: number;
}

interface TerritoryRow {
  id: string;
  territory: string;
  available: boolean;
  contentStatuses?: string[];
}

/** Every territory row for an app, with the territory code resolved. */
async function readTerritories(ctx: MacroContext, appId: string): Promise<TerritoryRow[]> {
  const { data } = await getAllWithIncluded(
    ctx,
    `/v2/appAvailabilities/${appId}/territoryAvailabilities`,
    { include: 'territory', limit: 200 }
  );
  return data.map((row: any) => ({
    id: row.id,
    territory: row.relationships?.territory?.data?.id ?? row.id,
    available: row.attributes?.available === true,
    contentStatuses: row.attributes?.contentStatuses ?? undefined,
  }));
}

export async function availabilitySet(
  ctx: MacroContext,
  args: { app: string; state: 'on' | 'off'; territories?: string[] }
): Promise<unknown> {
  if (args.state !== 'on' && args.state !== 'off') {
    throw new Error(`state must be "on" or "off", not ${JSON.stringify(args.state)}.`);
  }
  const target = args.state === 'on';

  const app = await resolveApp(ctx, args.app);
  const before = await readTerritories(ctx, app.id);

  if (!before.length) {
    throw new Error(
      `${app.bundleId} has no territory availability record yet. An app that has never been ` +
        `released has none; create one with asc_write appAvailabilitiesV2_createInstance.`
    );
  }

  const wanted = args.territories?.length
    ? new Set(args.territories.map((t) => t.toUpperCase()))
    : undefined;
  if (wanted) {
    const known = new Set(before.map((r) => r.territory));
    const unknown = [...wanted].filter((t) => !known.has(t));
    if (unknown.length) {
      throw new Error(
        `Not territories of ${app.bundleId}: ${unknown.join(', ')}. Codes are ISO alpha-3 ` +
          `(USA, not US) — the two-letter form matches nothing rather than erroring.`
      );
    }
  }

  const scope = before.filter((r) => !wanted || wanted.has(r.territory));
  const operations: Operation[] = [];

  for (const row of scope) {
    // Already right: skip the write. Makes a re-run cheap and idempotent, and
    // means `changed` counts real changes rather than requests sent.
    if (row.available === target) {
      operations.push({ territory: row.territory, from: row.available, to: target, status: 'unchanged' });
      continue;
    }

    // Sequential on purpose. Nothing in this server bounds concurrency, and the
    // rate limiter admits 300/minute, so firing 175 PATCHes at once would put
    // all of them in flight together.
    try {
      await ctx.client.request({
        baseUrl: ctx.baseUrl,
        method: 'PATCH',
        path: `/v1/territoryAvailabilities/${row.id}`,
        body: {
          data: {
            type: 'territoryAvailabilities',
            id: row.id,
            attributes: { available: target },
          },
        },
        audience: 'connect',
      });
      operations.push({ territory: row.territory, from: row.available, to: target, status: 'changed' });
    } catch (error) {
      // Carry on. Stopping here would leave the store half-switched and lose
      // the record of which territories had already been written.
      const api = error instanceof ApiError ? error : undefined;
      operations.push({
        territory: row.territory,
        from: row.available,
        to: target,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        ambiguous: api?.ambiguous,
        httpStatus: api?.status,
      });
    }
  }

  // Verify rather than assume. This is the step that catches a territory the
  // loop never visited, which is invisible from the operation log alone.
  const after = await readTerritories(ctx, app.id);
  const byTerritory = new Map(after.map((r) => [r.territory, r]));
  const mismatched = scope
    .filter((r) => byTerritory.get(r.territory)?.available !== target)
    .map((r) => r.territory);

  const changed = operations.filter((o) => o.status === 'changed').length;
  const unchanged = operations.filter((o) => o.status === 'unchanged').length;
  const failed = operations.filter((o) => o.status === 'failed');

  // Apple applies these asynchronously, so a territory can read as not-yet-
  // matching for a short while after a successful write.
  const processing = after.filter((r) => r.contentStatuses?.some((s) => s.startsWith('PROCESSING'))).length;

  return {
    app,
    requested: { state: args.state, territories: scope.length },
    changed,
    unchanged,
    failed: failed.map((f) => ({
      territory: f.territory,
      httpStatus: f.httpStatus,
      error: f.error,
      ambiguous: f.ambiguous,
    })),
    verified: {
      matching: scope.length - mismatched.length,
      total: scope.length,
      mismatched,
      processing,
    },
    operations,
    note:
      'Territory codes are ISO alpha-3 (USA, not US). `availableInNewTerritories` cannot be set ' +
      'here — Apple answers 403 "does not allow UPDATE" on an existing record, so it is web-UI ' +
      'only. A mismatched territory is worth re-reading once: Apple applies these asynchronously ' +
      'and reports PROCESSING_TO_AVAILABLE in the meantime. `ambiguous` on a failure means the ' +
      'write timed out and was deliberately not retried — it may still have landed.',
  };
}
