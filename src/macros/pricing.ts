/**
 * Subscription pricing.
 *
 * Reading a price is a four-hop walk — app → subscriptionGroups →
 * subscriptions → prices — and the answer is spread across three resources:
 * the price row names a price point, the price point holds the amount, and the
 * **currency lives on the territory**, not on either. Fetching them separately
 * is ~175 requests per subscription; asking for them as `included` resources
 * makes it one.
 *
 * Writing is where the care goes. `preserveCurrentPrice` decides whether
 * existing subscribers keep what they pay or get moved to the new price, and
 * Apple defaults it to false. That is a revenue decision no model should make
 * silently, so the parameter is required here even though Apple treats it as
 * optional — the caller has to state an intent before the call is built.
 */
import { get, getAll, indexIncluded, resolveApp, type MacroContext } from './support.js';

interface TerritoryPrice {
  territory: string;
  currency?: string;
  customerPrice?: string;
  proceeds?: string;
  /** True when existing subscribers were left on their old price. */
  preserved?: boolean;
  startDate?: string | null;
  priceId: string;
  pricePointId?: string;
}

export async function pricingGet(
  ctx: MacroContext,
  args: { app: string; subscription?: string; territory?: string }
): Promise<unknown> {
  const app = await resolveApp(ctx, args.app);

  const groups = await getAll(ctx, `/v1/apps/${app.id}/subscriptionGroups`, {
    'fields[subscriptionGroups]': 'referenceName',
    limit: 50,
  });

  const results: unknown[] = [];

  for (const group of groups) {
    const subs = await getAll(ctx, `/v1/subscriptionGroups/${group.id}/subscriptions`, {
      'fields[subscriptions]': 'name,productId,state,subscriptionPeriod',
      limit: 100,
    });

    for (const sub of subs) {
      if (
        args.subscription &&
        args.subscription !== sub.id &&
        args.subscription !== sub.attributes?.productId &&
        args.subscription !== sub.attributes?.name
      ) {
        continue;
      }

      // One request instead of ~175: the price rows plus the two resources
      // needed to interpret them.
      const query: Record<string, unknown> = {
        include: 'territory,subscriptionPricePoint',
        'fields[subscriptionPrices]': 'startDate,preserved,territory,subscriptionPricePoint',
        'fields[subscriptionPricePoints]': 'customerPrice,proceeds',
        'fields[territories]': 'currency',
        limit: 200,
      };
      if (args.territory) query['filter[territory]'] = args.territory.toUpperCase();

      const body = await get(ctx, `/v1/subscriptions/${sub.id}/prices`, query);
      const included = indexIncluded(body);

      const prices: TerritoryPrice[] = (body.data ?? []).map((row: any) => {
        const territoryId = row.relationships?.territory?.data?.id;
        const pointId = row.relationships?.subscriptionPricePoint?.data?.id;
        const point = pointId ? included.get(`subscriptionPricePoints:${pointId}`) : undefined;
        const territory = territoryId ? included.get(`territories:${territoryId}`) : undefined;
        return {
          territory: territoryId,
          currency: territory?.attributes?.currency,
          customerPrice: point?.attributes?.customerPrice,
          proceeds: point?.attributes?.proceeds,
          preserved: row.attributes?.preserved,
          startDate: row.attributes?.startDate ?? null,
          priceId: row.id,
          pricePointId: pointId,
        };
      });

      // Grouping by amount makes an outlier territory obvious, which a flat
      // list of 175 rows does not.
      const byPrice = new Map<string, string[]>();
      for (const p of prices) {
        const key = `${p.customerPrice ?? '?'} ${p.currency ?? ''}`.trim();
        byPrice.set(key, [...(byPrice.get(key) ?? []), p.territory]);
      }

      results.push({
        subscription: {
          id: sub.id,
          name: sub.attributes?.name,
          productId: sub.attributes?.productId,
          state: sub.attributes?.state,
          period: sub.attributes?.subscriptionPeriod,
          group: group.attributes?.referenceName,
        },
        territoriesWithAPrice: prices.length,
        groupedByPrice: [...byPrice.entries()]
          .map(([price, territories]) => ({ price, count: territories.length, territories }))
          .sort((a, b) => b.count - a.count),
        prices,
      });
    }
  }

  if (!results.length) {
    throw new Error(
      args.subscription
        ? `No subscription matched "${args.subscription}" in ${app.bundleId}.`
        : `${app.bundleId} has no subscriptions.`
    );
  }

  return {
    app,
    subscriptions: results,
    note:
      'Territory codes are ISO alpha-3 (USA, not US). A filter using the two-letter form returns ' +
      'an empty list rather than an error, which reads as "not sold there".',
  };
}

export async function planPriceChange(
  ctx: MacroContext,
  args: {
    app: string;
    subscription: string;
    price_point_id: string;
    preserve_current_price: boolean;
    territory?: string;
    start_date?: string;
  }
): Promise<{
  request: { method: 'POST'; path: string; body: unknown };
  effect: string;
  subscriptionId: string;
  app: { id: string; bundleId: string; name: string };
}> {
  if (typeof args.preserve_current_price !== 'boolean') {
    throw new Error(
      'preserve_current_price must be set explicitly to true or false.\n' +
        '  true  — existing subscribers keep the price they pay now; only new subscribers see the new one.\n' +
        '  false — existing subscribers are moved to the new price at their next renewal.\n' +
        'Apple defaults this to false. Ask the user which they intend before calling.'
    );
  }

  const app = await resolveApp(ctx, args.app);

  // Locate the subscription by id, productId or name.
  const groups = await getAll(ctx, `/v1/apps/${app.id}/subscriptionGroups`, { limit: 50 });
  let subscriptionId: string | undefined;
  for (const group of groups) {
    const subs = await getAll(ctx, `/v1/subscriptionGroups/${group.id}/subscriptions`, {
      'fields[subscriptions]': 'name,productId',
      limit: 100,
    });
    const hit = subs.find(
      (s: any) =>
        s.id === args.subscription ||
        s.attributes?.productId === args.subscription ||
        s.attributes?.name === args.subscription
    );
    if (hit) {
      subscriptionId = hit.id;
      break;
    }
  }
  if (!subscriptionId) {
    throw new Error(`No subscription matched "${args.subscription}" in ${app.bundleId}.`);
  }

  const body = {
    data: {
      type: 'subscriptionPrices',
      attributes: {
        preserveCurrentPrice: args.preserve_current_price,
        ...(args.start_date ? { startDate: args.start_date } : {}),
      },
      relationships: {
        subscription: { data: { type: 'subscriptions', id: subscriptionId } },
        subscriptionPricePoint: {
          data: { type: 'subscriptionPricePoints', id: args.price_point_id },
        },
        ...(args.territory
          ? { territory: { data: { type: 'territories', id: args.territory.toUpperCase() } } }
          : {}),
      },
    },
  };

  return {
    request: { method: 'POST' as const, path: '/v1/subscriptionPrices', body },
    effect: args.preserve_current_price
      ? 'Existing subscribers keep their current price. Only new subscribers pay the new one.'
      : 'Existing subscribers WILL be moved to the new price at their next renewal.',
    subscriptionId,
    app,
  };
}
