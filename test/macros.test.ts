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

// ---------------------------------------------------------------------------
describe('app resolution', () => {
  it('accepts a numeric Apple ID', async () => {
    mock.use(
      http.get(`${BASE}/v1/apps/9999`, () =>
        HttpResponse.json({ data: { id: '9999', attributes: { bundleId: 'com.x', name: 'X' } } })
      ),
      http.get(`${BASE}/v1/apps/9999/subscriptionGroups`, () => HttpResponse.json({ data: [] }))
    );
    // Resolution succeeds by numeric id; the failure is the empty group list.
    const { out } = await call('asc_pricing_get', { app: '9999' });
    expect(out.error).toMatch(/no subscriptions/);
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

  it('says so when the app has no subscriptions', async () => {
    mock.use(appLookup(), http.get(`${BASE}/v1/apps/123/subscriptionGroups`, () => HttpResponse.json({ data: [] })));
    const { out } = await call('asc_pricing_get', { app: 'com.example.app' });
    expect(out.error).toMatch(/no subscriptions/);
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
