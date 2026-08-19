/**
 * What an app charges — subscriptions and one-time purchases alike.
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
 *
 * Reading covers both product kinds because an app that sells only a
 * non-consumable has pricing too. Answering "no subscriptions" for such an app
 * reads as "no pricing", which is the absence-is-not-emptiness trap the
 * cookbook is written to prevent.
 */
import {
  get,
  getAll,
  getAllWithIncluded,
  indexIncluded,
  resolveApp,
  type MacroContext,
} from './support.js';

interface TerritoryPrice {
  territory: string;
  currency?: string;
  customerPrice?: string;
  proceeds?: string;
  /** Subscriptions: existing subscribers were left on their old price. */
  preserved?: boolean;
  /** One-time purchases: set deliberately, rather than equalised by Apple. */
  manual?: boolean;
  startDate?: string | null;
  priceId: string;
  pricePointId?: string;
}

/**
 * Grouping by amount makes an outlier territory obvious, which a flat list of
 * 175 rows does not.
 */
function groupByPrice(prices: TerritoryPrice[]): { price: string; count: number; territories: string[] }[] {
  const byPrice = new Map<string, string[]>();
  for (const p of prices) {
    const key = `${p.customerPrice ?? '?'} ${p.currency ?? ''}`.trim();
    byPrice.set(key, [...(byPrice.get(key) ?? []), p.territory]);
  }
  return [...byPrice.entries()]
    .map(([price, territories]) => ({ price, count: territories.length, territories }))
    .sort((a, b) => b.count - a.count);
}

/** Does this product match what the caller asked for, by id, product ID or name? */
function matchesProduct(filter: string | undefined, row: any): boolean {
  if (!filter) return true;
  return filter === row.id || filter === row.attributes?.productId || filter === row.attributes?.name;
}

/**
 * One leg of an in-app purchase's price schedule.
 *
 * `manualPrices` is what was set deliberately (the base territory); everything
 * else is `automaticPrices`, equalised by Apple from it. Both carry the amount
 * on a sideloaded price point and the currency on a sideloaded territory, so
 * they are read exactly the way subscription prices are.
 */
async function iapPriceRows(
  ctx: MacroContext,
  scheduleId: string,
  relationship: 'manualPrices' | 'automaticPrices',
  territory?: string
): Promise<TerritoryPrice[]> {
  const query: Record<string, unknown> = {
    include: 'inAppPurchasePricePoint,territory',
    'fields[inAppPurchasePrices]': 'startDate,endDate,manual,territory,inAppPurchasePricePoint',
    'fields[inAppPurchasePricePoints]': 'customerPrice,proceeds',
    'fields[territories]': 'currency',
    limit: 200,
  };
  if (territory) query['filter[territory]'] = territory.toUpperCase();

  const { data, included } = await getAllWithIncluded(
    ctx,
    `/v1/inAppPurchasePriceSchedules/${scheduleId}/${relationship}`,
    query
  );

  return data.map((row: any) => {
    const territoryId = row.relationships?.territory?.data?.id;
    const pointId = row.relationships?.inAppPurchasePricePoint?.data?.id;
    // `included` is keyed by the plural JSON:API type, not the singular
    // relationship name that points at it.
    const point = pointId ? included.get(`inAppPurchasePricePoints:${pointId}`) : undefined;
    const terr = territoryId ? included.get(`territories:${territoryId}`) : undefined;
    return {
      territory: territoryId,
      currency: terr?.attributes?.currency,
      customerPrice: point?.attributes?.customerPrice,
      proceeds: point?.attributes?.proceeds,
      manual: row.attributes?.manual,
      startDate: row.attributes?.startDate ?? null,
      priceId: row.id,
      pricePointId: pointId,
    };
  });
}

/** Every one-time purchase on the app, priced. */
async function inAppPurchasePricing(
  ctx: MacroContext,
  appId: string,
  args: { product?: string; territory?: string }
): Promise<unknown[]> {
  const iaps = await getAll(ctx, `/v1/apps/${appId}/inAppPurchasesV2`, {
    'fields[inAppPurchases]': 'name,productId,inAppPurchaseType,state',
    limit: 200,
  });

  const results: unknown[] = [];

  for (const iap of iaps) {
    if (!matchesProduct(args.product, iap)) continue;

    const schedule = await get(ctx, `/v2/inAppPurchases/${iap.id}/iapPriceSchedule`, {
      include: 'baseTerritory',
    });
    const scheduleId: string | undefined = schedule?.data?.id;
    if (!scheduleId) continue;

    const prices = [
      ...(await iapPriceRows(ctx, scheduleId, 'manualPrices', args.territory)),
      ...(await iapPriceRows(ctx, scheduleId, 'automaticPrices', args.territory)),
    ];

    results.push({
      inAppPurchase: {
        id: iap.id,
        name: iap.attributes?.name,
        productId: iap.attributes?.productId,
        type: iap.attributes?.inAppPurchaseType,
        state: iap.attributes?.state,
      },
      baseTerritory: schedule?.data?.relationships?.baseTerritory?.data?.id,
      territoriesWithAPrice: prices.length,
      groupedByPrice: groupByPrice(prices),
      prices,
    });
  }

  return results;
}

export async function pricingGet(
  ctx: MacroContext,
  args: { app: string; subscription?: string; product?: string; territory?: string }
): Promise<unknown> {
  const app = await resolveApp(ctx, args.app);
  // One filter, either product kind. `subscription` is the older name for it.
  const productFilter = args.product ?? args.subscription;

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
      if (!matchesProduct(productFilter, sub)) continue;

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
        groupedByPrice: groupByPrice(prices),
        prices,
      });
    }
  }

  const inAppPurchases = await inAppPurchasePricing(ctx, app.id, {
    product: productFilter,
    territory: args.territory,
  });

  // Absence of one kind is not absence of pricing. Throw only when the app
  // sells nothing at all — answering "has no subscriptions" for an app whose
  // whole business is a non-consumable reads as "has no pricing", and sent one
  // caller hand-walking price schedules that this tool already covers.
  if (!results.length && !inAppPurchases.length) {
    throw new Error(
      productFilter
        ? `No subscription or in-app purchase matched "${productFilter}" in ${app.bundleId}.`
        : `${app.bundleId} has no subscriptions and no in-app purchases.`
    );
  }

  return {
    app,
    subscriptions: results,
    inAppPurchases,
    note:
      'Territory codes are ISO alpha-3 (USA, not US). A filter using the two-letter form returns ' +
      'an empty list rather than an error, which reads as "not sold there". For one-time ' +
      'purchases, `manual: true` is the price set deliberately (the base territory); the rest ' +
      'are equalised by Apple from it.',
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
