/**
 * Macro tests drive the whole chain against a mocked Apple, because the value
 * of a macro is precisely the sequence — testing the hops individually would
 * miss the part that is worth having.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { gzipSync } from 'node:zlib';
import { generateKeyPairSync, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import type { Config } from '../src/config.js';

const BASE = 'https://api.appstoreconnect.apple.com';
const { privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

/**
 * Node pools small Buffers, so `buf.buffer` is the whole pool rather than
 * these bytes. Copying out is the only way to hand MSW the real payload.
 */
const gz = (text: string): ArrayBuffer => {
  const b = gzipSync(Buffer.from(text));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

const mock = setupServer();
beforeAll(() => mock.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mock.resetHandlers());
afterAll(() => mock.close());

const config: Config = {
  keyRef: privateKey,
  issuerId: 'issuer-uuid',
  keyId: 'ABC123KEYD',
  bundleId: 'com.example.app',
  safety: 'default',
  transport: 'stdio',
  host: '127.0.0.1',
  port: 8787,
  onlineChecks: false,
  redactPii: false,
  storekitEnvironment: 'Production',
};

async function connect(overrides: Partial<Config> = {}) {
  const server = createServer({ ...config, ...overrides });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: () => client.close() };
}

const payload = (r: any) => JSON.parse(r.content[0].text);
const call = async (name: string, args: Record<string, unknown>) => {
  const { client, close } = await connect();
  const res = await client.callTool({ name, arguments: args });
  await close();
  return { res, out: payload(res) };
};

/** Every macro starts by resolving the app. */
function appLookup(id = '123', bundleId = 'com.example.app') {
  return http.get(`${BASE}/v1/apps`, ({ request }) => {
    const url = new URL(request.url);
    if (url.searchParams.get('filter[bundleId]') === bundleId || url.searchParams.get('filter[name]')) {
      return HttpResponse.json({ data: [{ id, type: 'apps', attributes: { bundleId, name: 'Example' } }] });
    }
    return HttpResponse.json({ data: [] });
  });
}

/**
 * asc_pricing_get reads both product kinds, so every pricing chain needs this
 * hop even when the app sells no one-time purchases.
 */
function noIaps(appId = '123') {
  return http.get(`${BASE}/v1/apps/${appId}/inAppPurchasesV2`, () => HttpResponse.json({ data: [] }));
}

// ---------------------------------------------------------------------------
describe('app resolution', () => {
  it('accepts a numeric Apple ID', async () => {
    mock.use(
      http.get(`${BASE}/v1/apps/9999`, () =>
        HttpResponse.json({ data: { id: '9999', attributes: { bundleId: 'com.x', name: 'X' } } })
      ),
      http.get(`${BASE}/v1/apps/9999/subscriptionGroups`, () => HttpResponse.json({ data: [] })),
      noIaps('9999')
    );
    // Resolution succeeds by numeric id; the failure is that it sells nothing.
    const { out } = await call('asc_pricing_get', { app: '9999' });
    expect(out.error).toMatch(/no subscriptions and no in-app purchases/);
  });

  it('says what to try when nothing matches', async () => {
    mock.use(http.get(`${BASE}/v1/apps`, () => HttpResponse.json({ data: [] })));
    const { out } = await call('asc_pricing_get', { app: 'com.nope' });
    expect(out.error).toMatch(/No app matched/);
    expect(out.error).toMatch(/numeric Apple ID/);
  });

  it('refuses an ambiguous name rather than guessing', async () => {
    mock.use(
      http.get(`${BASE}/v1/apps`, () =>
        HttpResponse.json({
          data: [
            { id: '1', attributes: { bundleId: 'com.a', name: 'Thing' } },
            { id: '2', attributes: { bundleId: 'com.b', name: 'Thing' } },
          ],
        })
      )
    );
    const { out } = await call('asc_pricing_get', { app: 'Thing' });
    expect(out.error).toMatch(/matched 2 apps/);
  });
});

// ---------------------------------------------------------------------------
describe('asc_pricing_get', () => {
  const pricingHandlers = [
    appLookup(),
    noIaps(),
    http.get(`${BASE}/v1/apps/123/subscriptionGroups`, () =>
      HttpResponse.json({ data: [{ id: 'g1', attributes: { referenceName: 'Main' } }] })
    ),
    http.get(`${BASE}/v1/subscriptionGroups/g1/subscriptions`, () =>
      HttpResponse.json({
        data: [{ id: 's1', attributes: { name: 'Monthly', productId: 'com.example.monthly', state: 'APPROVED' } }],
      })
    ),
    http.get(`${BASE}/v1/subscriptions/s1/prices`, () =>
      HttpResponse.json({
        data: [
          {
            id: 'p1',
            attributes: { preserved: false, startDate: null },
            relationships: {
              territory: { data: { id: 'USA', type: 'territories' } },
              subscriptionPricePoint: { data: { id: 'pp1', type: 'subscriptionPricePoints' } },
            },
          },
          {
            id: 'p2',
            attributes: { preserved: true, startDate: null },
            relationships: {
              territory: { data: { id: 'GBR', type: 'territories' } },
              subscriptionPricePoint: { data: { id: 'pp2', type: 'subscriptionPricePoints' } },
            },
          },
        ],
        included: [
          { id: 'USA', type: 'territories', attributes: { currency: 'USD' } },
          { id: 'GBR', type: 'territories', attributes: { currency: 'GBP' } },
          { id: 'pp1', type: 'subscriptionPricePoints', attributes: { customerPrice: '4.99', proceeds: '3.49' } },
          { id: 'pp2', type: 'subscriptionPricePoints', attributes: { customerPrice: '4.99', proceeds: '3.49' } },
        ],
      })
    ),
  ];

  it('resolves the currency from the territory, not the price row', async () => {
    mock.use(...pricingHandlers);
    const { out } = await call('asc_pricing_get', { app: 'com.example.app' });
    const prices = out.subscriptions[0].prices;
    expect(prices.find((p: any) => p.territory === 'USA').currency).toBe('USD');
    expect(prices.find((p: any) => p.territory === 'GBR').currency).toBe('GBP');
    expect(prices[0].customerPrice).toBe('4.99');
  });

  it('groups territories by price so an outlier is visible', async () => {
    mock.use(...pricingHandlers);
    const { out } = await call('asc_pricing_get', { app: 'com.example.app' });
    const grouped = out.subscriptions[0].groupedByPrice;
    expect(grouped[0].count).toBe(1); // 4.99 USD and 4.99 GBP are different rows
    expect(out.subscriptions[0].territoriesWithAPrice).toBe(2);
  });

  it('reports whether existing subscribers were preserved', async () => {
    mock.use(...pricingHandlers);
    const { out } = await call('asc_pricing_get', { app: 'com.example.app' });
    expect(out.subscriptions[0].prices.find((p: any) => p.territory === 'GBR').preserved).toBe(true);
  });

  it('warns about the alpha-3 territory trap', async () => {
    mock.use(...pricingHandlers);
    const { out } = await call('asc_pricing_get', { app: 'com.example.app' });
    expect(out.note).toMatch(/alpha-3/);
  });

  it('errors only when the app sells nothing at all', async () => {
    mock.use(
      appLookup(),
      http.get(`${BASE}/v1/apps/123/subscriptionGroups`, () => HttpResponse.json({ data: [] })),
      noIaps()
    );
    const { out } = await call('asc_pricing_get', { app: 'com.example.app' });
    expect(out.error).toMatch(/no subscriptions and no in-app purchases/);
  });
});

// ---------------------------------------------------------------------------
/**
 * An app whose whole business is a one-time purchase still has pricing. This
 * used to throw "has no subscriptions", which reads as "has no pricing" and
 * sent a caller hand-walking price schedules the tool already covers.
 */
describe('asc_pricing_get — one-time purchases', () => {
  const iapHandlers = [
    appLookup(),
    http.get(`${BASE}/v1/apps/123/subscriptionGroups`, () => HttpResponse.json({ data: [] })),
    http.get(`${BASE}/v1/apps/123/inAppPurchasesV2`, () =>
      HttpResponse.json({
        data: [
          {
            id: 'iap1',
            attributes: {
              name: 'Pro',
              productId: 'com.example.pro',
              inAppPurchaseType: 'NON_CONSUMABLE',
              state: 'READY_TO_SUBMIT',
            },
          },
        ],
      })
    ),
    http.get(`${BASE}/v2/inAppPurchases/iap1/iapPriceSchedule`, () =>
      HttpResponse.json({
        data: { id: 'sched1', relationships: { baseTerritory: { data: { id: 'USA', type: 'territories' } } } },
      })
    ),
    http.get(`${BASE}/v1/inAppPurchasePriceSchedules/sched1/manualPrices`, () =>
      HttpResponse.json({
        data: [
          {
            id: 'm1',
            attributes: { manual: true, startDate: null },
            relationships: {
              territory: { data: { id: 'USA', type: 'territories' } },
              inAppPurchasePricePoint: { data: { id: 'ppUSA', type: 'inAppPurchasePricePoints' } },
            },
          },
        ],
        included: [
          { id: 'USA', type: 'territories', attributes: { currency: 'USD' } },
          { id: 'ppUSA', type: 'inAppPurchasePricePoints', attributes: { customerPrice: '4.99', proceeds: '3.50' } },
        ],
      })
    ),
    http.get(`${BASE}/v1/inAppPurchasePriceSchedules/sched1/automaticPrices`, () =>
      HttpResponse.json({
        data: [
          {
            id: 'a1',
            attributes: { manual: false, startDate: null },
            relationships: {
              territory: { data: { id: 'EGY', type: 'territories' } },
              inAppPurchasePricePoint: { data: { id: 'ppEGY', type: 'inAppPurchasePricePoints' } },
            },
          },
        ],
        included: [
          { id: 'EGY', type: 'territories', attributes: { currency: 'EGP' } },
          { id: 'ppEGY', type: 'inAppPurchasePricePoints', attributes: { customerPrice: '249.99', proceeds: '153.50' } },
        ],
      })
    ),
  ];

  it('prices an app that has no subscriptions at all', async () => {
    mock.use(...iapHandlers);
    const { out } = await call('asc_pricing_get', { app: 'com.example.app' });
    expect(out.error).toBeUndefined();
    expect(out.subscriptions).toEqual([]);
    expect(out.inAppPurchases).toHaveLength(1);
    expect(out.inAppPurchases[0].inAppPurchase.productId).toBe('com.example.pro');
    expect(out.inAppPurchases[0].inAppPurchase.type).toBe('NON_CONSUMABLE');
  });

  it('resolves the amount from the price point and the currency from the territory', async () => {
    mock.use(...iapHandlers);
    const { out } = await call('asc_pricing_get', { app: 'com.example.app' });
    const prices = out.inAppPurchases[0].prices;
    const usa = prices.find((p: any) => p.territory === 'USA');
    const egy = prices.find((p: any) => p.territory === 'EGY');
    expect(usa).toMatchObject({ currency: 'USD', customerPrice: '4.99', proceeds: '3.50' });
    expect(egy).toMatchObject({ currency: 'EGP', customerPrice: '249.99' });
  });

  it('distinguishes the deliberate base price from Apple’s equalised ones', async () => {
    mock.use(...iapHandlers);
    const { out } = await call('asc_pricing_get', { app: 'com.example.app' });
    const prices = out.inAppPurchases[0].prices;
    expect(prices.find((p: any) => p.territory === 'USA').manual).toBe(true);
    expect(prices.find((p: any) => p.territory === 'EGY').manual).toBe(false);
    expect(out.inAppPurchases[0].baseTerritory).toBe('USA');
  });
});

// ---------------------------------------------------------------------------
describe('asc_pricing_set', () => {
  const setup = [
    appLookup(),
    http.get(`${BASE}/v1/apps/123/subscriptionGroups`, () => HttpResponse.json({ data: [{ id: 'g1', attributes: {} }] })),
    http.get(`${BASE}/v1/subscriptionGroups/g1/subscriptions`, () =>
      HttpResponse.json({ data: [{ id: 's1', attributes: { productId: 'com.example.monthly', name: 'Monthly' } }] })
    ),
  ];

  it('is gated as REVENUE and states the effect before running', async () => {
    mock.use(...setup);
    const { out } = await call('asc_pricing_set', {
      app: 'com.example.app',
      subscription: 'com.example.monthly',
      price_point_id: 'pp9',
      preserve_current_price: false,
    });
    expect(out.confirmationRequired).toBe(true);
    expect(out.risk).toBe('REVENUE');
    expect(out.willDo).toMatch(/WILL be moved/);
  });

  it('sends preserveCurrentPrice exactly as given once confirmed', async () => {
    let sent: any;
    mock.use(
      ...setup,
      http.post(`${BASE}/v1/subscriptionPrices`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ data: { id: 'newprice' } });
      })
    );
    const { client, close } = await connect({ safety: 'no-confirm' });
    const res = await client.callTool({
      name: 'asc_pricing_set',
      arguments: {
        app: 'com.example.app',
        subscription: 'com.example.monthly',
        price_point_id: 'pp9',
        preserve_current_price: true,
      },
    });
    expect(payload(res).applied).toBe(true);
    expect(sent.data.attributes.preserveCurrentPrice).toBe(true);
    expect(sent.data.relationships.subscription.data.id).toBe('s1');
    await close();
  });

  // Apple defaults this to false; leaving it implicit silently re-prices the
  // existing subscriber base.
  it('refuses to proceed when preserve_current_price is omitted', async () => {
    mock.use(...setup);
    const { client, close } = await connect({ safety: 'no-confirm' });
    const res = await client.callTool({
      name: 'asc_pricing_set',
      arguments: { app: 'com.example.app', subscription: 'com.example.monthly', price_point_id: 'pp9' },
    });
    expect(payload(res).error).toMatch(/must be set explicitly/);
    await close();
  });
});

// ---------------------------------------------------------------------------
describe('asc_preflight_version', () => {
  const version = (attrs: Record<string, unknown> = {}) => [
    appLookup(),
    http.get(`${BASE}/v1/apps/123/appStoreVersions`, () =>
      HttpResponse.json({ data: [{ id: 'v1', attributes: { versionString: '2.0', appStoreState: 'PREPARE_FOR_SUBMISSION', ...attrs } }] })
    ),
  ];
  const goodBuild = http.get(`${BASE}/v1/appStoreVersions/v1/build`, () =>
    HttpResponse.json({ data: { id: 'b1', attributes: { version: '42', processingState: 'VALID', expired: false, usesNonExemptEncryption: false } } })
  );
  const goodLocales = http.get(`${BASE}/v1/appStoreVersions/v1/appStoreVersionLocalizations`, () =>
    HttpResponse.json({ data: [{ id: 'l1', attributes: { locale: 'en-US', description: 'A description', supportUrl: 'https://x', keywords: 'a,b' } }] })
  );
  const goodSets = http.get(`${BASE}/v1/appStoreVersionLocalizations/l1/appScreenshotSets`, () =>
    HttpResponse.json({ data: [{ id: 'set1', attributes: { screenshotDisplayType: 'APP_IPHONE_67' } }] })
  );
  const goodReview = http.get(`${BASE}/v1/appStoreVersions/v1/appStoreReviewDetail`, () =>
    HttpResponse.json({ data: { id: 'rd1', attributes: { contactEmail: 'a@b.c', contactPhone: '+1', demoAccountRequired: false } } })
  );
  const noSubmissions = http.get(`${BASE}/v1/apps/123/reviewSubmissions`, () => HttpResponse.json({ data: [] }));

  it('returns GO when everything is in place', async () => {
    mock.use(...version(), goodBuild, goodLocales, goodSets, goodReview, noSubmissions);
    const { out } = await call('asc_preflight_version', { app: 'com.example.app' });
    expect(out.verdict).toBe('GO');
    expect(out.blocking).toHaveLength(0);
  });

  // The failure that strands a release with no visible explanation.
  it('blocks on unanswered export compliance and explains the symptom', async () => {
    mock.use(
      ...version(),
      http.get(`${BASE}/v1/appStoreVersions/v1/build`, () =>
        HttpResponse.json({ data: { id: 'b1', attributes: { version: '42', processingState: 'VALID', usesNonExemptEncryption: null } } })
      ),
      goodLocales, goodSets, goodReview, noSubmissions
    );
    const { out } = await call('asc_preflight_version', { app: 'com.example.app' });
    expect(out.verdict).toBe('NO-GO');
    const finding = out.blocking.find((f: any) => /export compliance/i.test(f.what));
    expect(finding.why).toMatch(/WAITING_FOR_EXPORT_COMPLIANCE/);
    expect(finding.fix).toMatch(/builds_updateInstance/);
  });

  it('blocks on a build still processing', async () => {
    mock.use(
      ...version(),
      http.get(`${BASE}/v1/appStoreVersions/v1/build`, () =>
        HttpResponse.json({ data: { id: 'b1', attributes: { version: '42', processingState: 'PROCESSING', usesNonExemptEncryption: false } } })
      ),
      goodLocales, goodSets, goodReview, noSubmissions
    );
    const { out } = await call('asc_preflight_version', { app: 'com.example.app' });
    expect(out.blocking.some((f: any) => /PROCESSING/.test(f.what))).toBe(true);
  });

  // Checking only the primary locale is how a missing description reaches review.
  it('checks every locale, not just the first', async () => {
    mock.use(
      ...version(), goodBuild,
      http.get(`${BASE}/v1/appStoreVersions/v1/appStoreVersionLocalizations`, () =>
        HttpResponse.json({
          data: [
            { id: 'l1', attributes: { locale: 'en-US', description: 'ok', supportUrl: 'https://x', keywords: 'a' } },
            { id: 'l2', attributes: { locale: 'de-DE', description: '', supportUrl: 'https://x', keywords: 'a' } },
          ],
        })
      ),
      goodSets, goodReview, noSubmissions
    );
    const { out } = await call('asc_preflight_version', { app: 'com.example.app' });
    expect(out.blocking.some((f: any) => f.what.includes('de-DE'))).toBe(true);
  });

  it('blocks when a demo account is required but blank', async () => {
    mock.use(
      ...version(), goodBuild, goodLocales, goodSets,
      http.get(`${BASE}/v1/appStoreVersions/v1/appStoreReviewDetail`, () =>
        HttpResponse.json({ data: { id: 'rd1', attributes: { contactEmail: 'a@b.c', contactPhone: '+1', demoAccountRequired: true, demoAccountName: '', demoAccountPassword: '' } } })
      ),
      noSubmissions
    );
    const { out } = await call('asc_preflight_version', { app: 'com.example.app' });
    expect(out.blocking.some((f: any) => /demo account/i.test(f.what))).toBe(true);
  });

  it('flags the 100-character keyword limit, commas included', async () => {
    mock.use(
      ...version(), goodBuild,
      http.get(`${BASE}/v1/appStoreVersions/v1/appStoreVersionLocalizations`, () =>
        HttpResponse.json({ data: [{ id: 'l1', attributes: { locale: 'en-US', description: 'ok', supportUrl: 'https://x', keywords: 'x'.repeat(101) } }] })
      ),
      goodSets, goodReview, noSubmissions
    );
    const { out } = await call('asc_preflight_version', { app: 'com.example.app' });
    expect(out.blocking.some((f: any) => /keyword limit/.test(f.what))).toBe(true);
  });

  it('warns rather than blocks on an open submission', async () => {
    mock.use(
      ...version(), goodBuild, goodLocales, goodSets, goodReview,
      http.get(`${BASE}/v1/apps/123/reviewSubmissions`, () =>
        HttpResponse.json({ data: [{ id: 'rs1', attributes: { state: 'IN_REVIEW' } }] })
      )
    );
    const { out } = await call('asc_preflight_version', { app: 'com.example.app' });
    expect(out.verdict).toBe('GO');
    expect(out.warnings.some((f: any) => /open review submission/.test(f.what))).toBe(true);
  });

  it('names a fixing operation for every finding', async () => {
    mock.use(
      ...version(),
      http.get(`${BASE}/v1/appStoreVersions/v1/build`, () => HttpResponse.json({ data: null })),
      goodLocales, goodSets, goodReview, noSubmissions
    );
    const { out } = await call('asc_preflight_version', { app: 'com.example.app' });
    for (const f of [...out.blocking, ...out.warnings]) expect(f.fix).toMatch(/asc_/);
  });
});

// ---------------------------------------------------------------------------
describe('asc_analytics_report', () => {
  const tsv = 'Date\tImpressions\tUnits\n2026-08-01\t100\t5\n2026-08-02\t150\t9\n';
  const tsv2 = 'Date\tImpressions\tUnits\n2026-08-03\t200\t11\n';

  const chain = (segments: Array<{ url: string }>) => [
    appLookup(),
    http.get(`${BASE}/v1/apps/123/analyticsReportRequests`, () =>
      HttpResponse.json({ data: [{ id: 'req1', attributes: { accessType: 'ONGOING', stoppedDueToInactivity: false } }] })
    ),
    http.get(`${BASE}/v1/analyticsReportRequests/req1/reports`, () =>
      HttpResponse.json({ data: [{ id: 'rep1', attributes: { name: 'App Store Discovery and Engagement', category: 'APP_STORE_ENGAGEMENT' } }] })
    ),
    http.get(`${BASE}/v1/analyticsReports/rep1/instances`, () =>
      HttpResponse.json({ data: [{ id: 'inst1', attributes: { granularity: 'DAILY', processingDate: '2026-08-15' } }] })
    ),
    http.get(`${BASE}/v1/analyticsReportInstances/inst1/segments`, () =>
      HttpResponse.json({ data: segments.map((s, i) => ({ id: `seg${i}`, attributes: { url: s.url, sizeInBytes: 100 } })) })
    ),
  ];

  it('gunzips the TSV and returns parsed rows', async () => {
    mock.use(
      ...chain([{ url: 'https://assets.apple.com/seg0' }]),
      http.get('https://assets.apple.com/seg0', () =>
        HttpResponse.arrayBuffer(gz(tsv))
      )
    );
    const { out } = await call('asc_analytics_report', { app: 'com.example.app', report_name: 'App Store Discovery and Engagement' });
    expect(out.columns).toEqual(['Date', 'Impressions', 'Units']);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]).toEqual({ Date: '2026-08-01', Impressions: '100', Units: '5' });
  });

  // Reading only segment 0 yields a plausible subset with nothing marking it partial.
  it('stitches every segment and says that it did', async () => {
    mock.use(
      ...chain([{ url: 'https://assets.apple.com/seg0' }, { url: 'https://assets.apple.com/seg1' }]),
      http.get('https://assets.apple.com/seg0', () => HttpResponse.arrayBuffer(gz(tsv))),
      http.get('https://assets.apple.com/seg1', () => HttpResponse.arrayBuffer(gz(tsv2)))
    );
    const { out } = await call('asc_analytics_report', { app: 'com.example.app', report_name: 'App Store Discovery and Engagement' });
    expect(out.segments).toEqual({ total: 2, allRead: true });
    expect(out.rowCount).toBe(3);
  });

  it('handles a segment that is not gzipped', async () => {
    mock.use(
      ...chain([{ url: 'https://assets.apple.com/plain' }]),
      http.get('https://assets.apple.com/plain', () => HttpResponse.text(tsv))
    );
    const { out } = await call('asc_analytics_report', { app: 'com.example.app', report_name: 'App Store' });
    expect(out.rowCount).toBe(2);
  });

  it('lists available reports when none is named', async () => {
    mock.use(...chain([]));
    const { out } = await call('asc_analytics_report', { app: 'com.example.app' });
    expect(out.reports[0].name).toBe('App Store Discovery and Engagement');
  });

  // Creating one is an ongoing commitment on the account, not a query.
  it('refuses to create a report request, and says why', async () => {
    mock.use(appLookup(), http.get(`${BASE}/v1/apps/123/analyticsReportRequests`, () => HttpResponse.json({ data: [] })));
    const { out } = await call('asc_analytics_report', { app: 'com.example.app' });
    expect(out.error).toMatch(/standing commitment/);
    expect(out.error).toMatch(/will not create one silently/);
  });

  it('explains an empty instance list instead of returning nothing', async () => {
    mock.use(
      appLookup(),
      http.get(`${BASE}/v1/apps/123/analyticsReportRequests`, () =>
        HttpResponse.json({ data: [{ id: 'req1', attributes: { accessType: 'ONGOING' } }] })
      ),
      http.get(`${BASE}/v1/analyticsReportRequests/req1/reports`, () =>
        HttpResponse.json({ data: [{ id: 'rep1', attributes: { name: 'Commerce', category: 'COMMERCE' } }] })
      ),
      http.get(`${BASE}/v1/analyticsReports/rep1/instances`, () => HttpResponse.json({ data: [] }))
    );
    const { out } = await call('asc_analytics_report', { app: 'com.example.app', report_name: 'Commerce' });
    expect(out.instances).toBe(0);
    expect(out.note).toMatch(/own schedule/);
  });

  it('caps rows and says the stitch was incomplete', async () => {
    const big = 'Date\tN\n' + Array.from({ length: 500 }, (_, i) => `2026-08-01\t${i}`).join('\n');
    mock.use(
      ...chain([{ url: 'https://assets.apple.com/big' }]),
      http.get('https://assets.apple.com/big', () => HttpResponse.arrayBuffer(gz(big)))
    );
    const { out } = await call('asc_analytics_report', { app: 'com.example.app', report_name: 'App Store', max_rows: 10 });
    expect(out.rowCount).toBe(10);
    expect(out.segments.allRead).toBe(false);
    expect(out.truncated).toMatch(/Raise max_rows/);
  });
});

// ---------------------------------------------------------------------------
describe('asc_upload_screenshot', () => {
  let file: string;
  const bytes = Buffer.from('PNGDATA'.repeat(50));
  const md5 = createHash('md5').update(bytes).digest('hex');

  beforeAll(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asc-shot-')), 'shot.png');
    fs.writeFileSync(file, bytes);
  });

  const reserve = (ops: unknown[]) =>
    http.post(`${BASE}/v1/appScreenshots`, () =>
      HttpResponse.json({ data: { id: 'shot1', attributes: { uploadOperations: ops } } })
    );

  it('performs reserve, upload and commit in order', async () => {
    const seen: string[] = [];
    let committed: any;
    mock.use(
      reserve([
        { method: 'PUT', url: 'https://assets.apple.com/part0', offset: 0, length: 175, requestHeaders: [{ name: 'X-Apple', value: 'yes' }] },
        { method: 'PUT', url: 'https://assets.apple.com/part1', offset: 175, length: bytes.length - 175, requestHeaders: [] },
      ]),
      http.put('https://assets.apple.com/part0', ({ request }) => {
        seen.push(`part0:${request.headers.get('X-Apple')}`);
        return new HttpResponse(null, { status: 200 });
      }),
      http.put('https://assets.apple.com/part1', () => {
        seen.push('part1');
        return new HttpResponse(null, { status: 200 });
      }),
      http.patch(`${BASE}/v1/appScreenshots/shot1`, async ({ request }) => {
        committed = await request.json();
        return HttpResponse.json({ data: { id: 'shot1', attributes: { assetDeliveryState: { state: 'COMPLETE' } } } });
      })
    );

    const { client, close } = await connect({ safety: 'no-confirm' });
    const res = await client.callTool({
      name: 'asc_upload_screenshot',
      arguments: { screenshot_set_id: 'set1', file_path: file },
    });
    const out = payload(res);

    expect(seen).toEqual(['part0:yes', 'part1']);
    expect(out.chunksUploaded).toBe(2);
    // The checksum is what tells Apple to assemble and validate the asset.
    expect(committed.data.attributes.sourceFileChecksum).toBe(md5);
    expect(committed.data.attributes.uploaded).toBe(true);
    expect(out.assetDeliveryState.state).toBe('COMPLETE');
    await close();
  });

  it('is gated as RELEASE before anything is reserved', async () => {
    // No handlers: a reservation would fail the test.
    const { out } = await call('asc_upload_screenshot', { screenshot_set_id: 'set1', file_path: file });
    expect(out.confirmationRequired).toBe(true);
    expect(out.risk).toBe('RELEASE');
  });

  it('tells you how to clean up a half-finished upload', async () => {
    mock.use(
      reserve([{ method: 'PUT', url: 'https://assets.apple.com/part0', offset: 0, length: bytes.length, requestHeaders: [] }]),
      http.put('https://assets.apple.com/part0', () => new HttpResponse(null, { status: 500 }))
    );
    const { client, close } = await connect({ safety: 'no-confirm' });
    const res = await client.callTool({
      name: 'asc_upload_screenshot',
      arguments: { screenshot_set_id: 'set1', file_path: file },
    });
    expect(payload(res).error).toMatch(/AWAITING_UPLOAD/);
    expect(payload(res).error).toMatch(/appScreenshots_deleteInstance id=shot1/);
    await close();
  });

  it('reports a missing file before touching Apple', async () => {
    const { client, close } = await connect({ safety: 'no-confirm' });
    const res = await client.callTool({
      name: 'asc_upload_screenshot',
      arguments: { screenshot_set_id: 'set1', file_path: '/nope/missing.png' },
    });
    expect(payload(res).error).toMatch(/No file at/);
    await close();
  });

  it('says so when Apple reserves a slot but returns nowhere to upload', async () => {
    mock.use(reserve([]));
    const { client, close } = await connect({ safety: 'no-confirm' });
    const res = await client.callTool({
      name: 'asc_upload_screenshot',
      arguments: { screenshot_set_id: 'set1', file_path: file },
    });
    expect(payload(res).error).toMatch(/no uploadOperations/);
    await close();
  });
});

// ---------------------------------------------------------------------------
describe('asc_listing_screenshots', () => {
  it('resolves screenshots through included resources', async () => {
    mock.use(
      appLookup(),
      http.get(`${BASE}/v1/apps/123/appStoreVersions`, () =>
        HttpResponse.json({ data: [{ id: 'v1', attributes: { versionString: '2.0' } }] })
      ),
      http.get(`${BASE}/v1/appStoreVersions/v1/appStoreVersionLocalizations`, () =>
        HttpResponse.json({ data: [{ id: 'l1', attributes: { locale: 'en-US' } }, { id: 'l2', attributes: { locale: 'de-DE' } }] })
      ),
      http.get(`${BASE}/v1/appStoreVersionLocalizations/l1/appScreenshotSets`, () =>
        HttpResponse.json({
          data: [{ id: 'set1', attributes: { screenshotDisplayType: 'APP_IPHONE_67' }, relationships: { appScreenshots: { data: [{ id: 'sh1' }] } } }],
          included: [{ id: 'sh1', type: 'appScreenshots', attributes: { fileName: 'a.png', fileSize: 100, assetDeliveryState: { state: 'COMPLETE' } } }],
        })
      )
    );
    const { out } = await call('asc_listing_screenshots', { app: 'com.example.app' });
    expect(out.inspected[0].sets[0].screenshots[0].fileName).toBe('a.png');
    expect(out.inspected[0].sets[0].screenshots[0].state).toBe('COMPLETE');
    // Reporting one locale as if it were all of them is the trap here.
    expect(out.localesOnVersion).toBe(2);
    expect(out.note).toMatch(/Showing 1 of 2 locales/);
  });
});

// ---------------------------------------------------------------------------
/**
 * Apple gives availability no bulk endpoint, so this is one PATCH per
 * territory. The failure that matters is not an error — it is a loop that
 * finishes having quietly skipped one, which reads as success.
 */
describe('asc_availability_set', () => {
  /** Serves "before" on the first read and "after" on the verification read. */
  function territories(before: Array<[string, boolean]>, after?: Array<[string, boolean]>) {
    let reads = 0;
    return http.get(`${BASE}/v2/appAvailabilities/123/territoryAvailabilities`, () => {
      const rows = reads++ === 0 ? before : (after ?? before);
      return HttpResponse.json({
        data: rows.map(([code, available]) => ({
          id: `ta-${code}`,
          attributes: { available, contentStatuses: [available ? 'AVAILABLE' : 'CANNOT_SELL'] },
          relationships: { territory: { data: { id: code, type: 'territories' } } },
        })),
        included: rows.map(([code]) => ({ id: code, type: 'territories', attributes: { currency: 'USD' } })),
      });
    });
  }

  const patchOk = () =>
    http.patch(`${BASE}/v1/territoryAvailabilities/:id`, ({ params }) =>
      HttpResponse.json({ data: { id: params.id, attributes: { available: true } } })
    );

  it('is gated as RELEASE and names the blast radius before running', async () => {
    // No handlers at all: a request before confirmation would fail the test.
    const { out } = await call('asc_availability_set', { app: 'com.example.app', state: 'off' });
    expect(out.confirmationRequired).toBe(true);
    expect(out.risk).toBe('RELEASE');
    expect(out.willDo).toMatch(/EVERY territory/);
    expect(out.willDo).toMatch(/stops being downloadable/);
  });

  it('accepts its own confirmation token', async () => {
    // The token is injected into the macro's own arguments, so fingerprinting
    // the whole argument object hashed {app,state} on the way out and
    // {app,state,confirm} on the way back in — and every gated macro rejected
    // its own token. Both calls must share one server: the gate holds pending
    // tokens in memory, so a second connection would never have issued it.
    const { client, close } = await connect();
    const args = { app: 'com.example.app', state: 'off' };

    const first = payload(await client.callTool({ name: 'asc_availability_set', arguments: args }));
    expect(first.token).toBeTruthy();

    mock.use(appLookup(), territories([['USA', true]], [['USA', false]]), patchOk());
    const second = payload(
      await client.callTool({ name: 'asc_availability_set', arguments: { ...args, confirm: first.token } })
    );
    await close();

    expect(second.error).toBeUndefined();
    expect(second.changed).toBe(1);
  });

  it('skips territories already in the target state', async () => {
    mock.use(appLookup(), territories([['USA', true], ['GBR', false]], [['USA', false], ['GBR', false]]), patchOk());
    const { client, close } = await connect({ safety: 'no-confirm' });
    const res = await client.callTool({ name: 'asc_availability_set', arguments: { app: 'com.example.app', state: 'off' } });
    await close();
    const out = payload(res);
    expect(out.changed).toBe(1);
    expect(out.unchanged).toBe(1);
    expect(out.operations.find((o: any) => o.territory === 'GBR').status).toBe('unchanged');
  });

  it('reports a territory the writes did not take effect on', async () => {
    // Both were asked to go off; the re-read says GBR is still on. An
    // operation log alone would call this a clean run.
    mock.use(appLookup(), territories([['USA', true], ['GBR', true]], [['USA', false], ['GBR', true]]), patchOk());
    const { client, close } = await connect({ safety: 'no-confirm' });
    const res = await client.callTool({ name: 'asc_availability_set', arguments: { app: 'com.example.app', state: 'off' } });
    await close();
    const out = payload(res);
    expect(out.changed).toBe(2);
    expect(out.verified.mismatched).toEqual(['GBR']);
    expect(out.verified.matching).toBe(1);
  });

  it('keeps going after a failure instead of abandoning the rest', async () => {
    mock.use(
      appLookup(),
      territories([['USA', true], ['GBR', true]], [['USA', false], ['GBR', true]]),
      http.patch(`${BASE}/v1/territoryAvailabilities/:id`, ({ params }) =>
        params.id === 'ta-GBR'
          ? HttpResponse.json({ errors: [{ status: '409', code: 'CONFLICT', detail: 'nope' }] }, { status: 409 })
          : HttpResponse.json({ data: { id: params.id } })
      )
    );
    const { client, close } = await connect({ safety: 'no-confirm' });
    const res = await client.callTool({ name: 'asc_availability_set', arguments: { app: 'com.example.app', state: 'off' } });
    await close();
    const out = payload(res);
    expect(out.changed).toBe(1);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].territory).toBe('GBR');
    expect(out.failed[0].httpStatus).toBe(409);
  });

  it('refuses a two-letter territory code rather than matching nothing', async () => {
    mock.use(appLookup(), territories([['USA', true]]));
    const { client, close } = await connect({ safety: 'no-confirm' });
    const res = await client.callTool({
      name: 'asc_availability_set',
      arguments: { app: 'com.example.app', state: 'off', territories: ['US'] },
    });
    await close();
    expect(payload(res).error).toMatch(/ISO alpha-3/);
  });
});

// ---------------------------------------------------------------------------
describe('asc_upload_iap_screenshot', () => {
  it('is gated as RELEASE', async () => {
    const { out } = await call('asc_upload_iap_screenshot', { iap: '6802176256', file_path: '/tmp/x.png' });
    expect(out.confirmationRequired).toBe(true);
    expect(out.risk).toBe('RELEASE');
  });

  it('says how to find the id when given a product ID', async () => {
    const { client, close } = await connect({ safety: 'no-confirm' });
    const res = await client.callTool({
      name: 'asc_upload_iap_screenshot',
      arguments: { iap: 'com.example.pro', file_path: '/tmp/x.png' },
    });
    await close();
    expect(payload(res).error).toMatch(/not a numeric in-app purchase id/);
  });
});
