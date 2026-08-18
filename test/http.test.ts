/**
 * Apple is mocked at the network boundary with MSW. `onUnhandledRequest:
 * 'error'` means any request this suite does not explicitly stub fails the
 * test — which doubles as a guarantee that no test ever reaches the real API.
 *
 * MSW rather than nock deliberately: nock patches node:http, and Node's global
 * fetch is undici, which bypasses node:http entirely. nock would silently
 * intercept nothing.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { generateKeyPairSync } from 'node:crypto';
import { ApiClient, ApiError, renderPath, assertAllowedUrl } from '../src/http.js';
import { TokenMinter } from '../src/jwt.js';
import { RateLimiter } from '../src/ratelimit.js';

const BASE = 'https://api.appstoreconnect.apple.com';
const { privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** A limiter that never paces, so retry timing is the only delay in play. */
const noPacing = () => new RateLimiter(1e9, 1e9, Date.now, async () => {});

function client(timeoutMs = 5000) {
  const minter = new TokenMinter(
    { privateKey: privateKey as unknown as string, issuerId: 'i', keyId: 'k', source: 'test' },
    'com.example.app'
  );
  return new ApiClient(minter, { timeoutMs }, noPacing());
}

const get = (spec: Partial<Parameters<ApiClient['request']>[0]> = {}) => ({
  baseUrl: BASE,
  method: 'GET',
  path: '/v1/apps',
  audience: 'connect' as const,
  ...spec,
});

describe('renderPath', () => {
  it('substitutes and encodes', () => {
    expect(renderPath('/v1/apps/{id}', { id: 'a b' })).toBe('/v1/apps/a%20b');
  });

  it('handles several parameters', () => {
    expect(renderPath('/x/{a}/y/{b}', { a: '1', b: '2' })).toBe('/x/1/y/2');
  });

  it('refuses rather than sending a URL with a placeholder still in it', () => {
    expect(() => renderPath('/v1/apps/{id}', {})).toThrow(/Missing required path parameter\(s\): id/);
    expect(() => renderPath('/v1/apps/{id}', { id: '' })).toThrow(/Missing/);
  });
});

describe('host pinning', () => {
  it('permits Apple’s hosts', () => {
    for (const h of ['api.appstoreconnect.apple.com', 'api.storekit.apple.com', 'api.storekit-sandbox.apple.com']) {
      expect(() => assertAllowedUrl(new URL(`https://${h}/x`))).not.toThrow();
    }
  });

  // A pagination cursor is server-supplied input; following one blindly would
  // walk a live bearer token to whatever host it names.
  it('refuses any other host', () => {
    expect(() => assertAllowedUrl(new URL('https://evil.example.com/v1/apps'))).toThrow(/Refusing to send credentials/);
  });

  it('refuses a lookalike subdomain', () => {
    expect(() => assertAllowedUrl(new URL('https://api.appstoreconnect.apple.com.evil.com/x'))).toThrow();
  });

  it('refuses plain HTTP', () => {
    expect(() => assertAllowedUrl(new URL('http://api.appstoreconnect.apple.com/x'))).toThrow(/non-HTTPS/);
  });
});

describe('query encoding', () => {
  it('repeats array values rather than comma-joining them', async () => {
    let seen = '';
    server.use(http.get(`${BASE}/v1/apps`, ({ request }) => {
      seen = new URL(request.url).search;
      return HttpResponse.json({ data: [] });
    }));
    await client().request(get({ query: { status: ['ACTIVE', 'EXPIRED'], limit: 5 } }));
    expect(seen).toContain('status=ACTIVE');
    expect(seen).toContain('status=EXPIRED');
    expect(seen).not.toContain('ACTIVE%2CEXPIRED');
  });

  it('omits null and undefined', async () => {
    let seen = '';
    server.use(http.get(`${BASE}/v1/apps`, ({ request }) => {
      seen = new URL(request.url).search;
      return HttpResponse.json({ data: [] });
    }));
    await client().request(get({ query: { a: null, b: undefined, c: 1 } }));
    expect(seen).toBe('?c=1');
  });
});

describe('responses', () => {
  it('captures Apple’s request id and rate-limit header', async () => {
    server.use(http.get(`${BASE}/v1/apps`, () =>
      HttpResponse.json({ data: [] }, {
        headers: { 'x-request-id': 'REQ123', 'x-rate-limit': 'user-hour-lim:3600;user-hour-rem:3000;' },
      })
    ));
    const c = client();
    const res = await c.request(get());
    expect(res.requestId).toBe('REQ123');
    // Apple's figure already accounts for the request it just served, so it
    // is stored verbatim rather than decremented again.
    expect(c.limiter.state.hourRemaining).toBe(3000);
  });

  it('shapes links out of the payload', async () => {
    server.use(http.get(`${BASE}/v1/apps`, () =>
      HttpResponse.json({ data: [{ id: '1', links: { self: 'x' } }], links: { self: 'y', next: 'z' } })
    ));
    const res = await client().request(get());
    expect((res.data as any).data[0].links).toBeUndefined();
    expect((res.data as any).links).toEqual({ next: 'z' });
  });
});

describe('error mapping', () => {
  it('renders a JSON:API error array', async () => {
    server.use(http.get(`${BASE}/v1/apps`, () =>
      HttpResponse.json({ errors: [{ status: '404', code: 'NOT_FOUND', title: 'Missing', detail: 'no such app' }] }, { status: 404 })
    ));
    await expect(client().request(get())).rejects.toThrow(/NOT_FOUND.*Missing.*no such app/);
  });

  it('renders the Server API error shape', async () => {
    server.use(http.get('https://api.storekit.apple.com/inApps/v1/transactions/x', () =>
      HttpResponse.json({ errorCode: 4000006, errorMessage: 'Invalid transaction id.' }, { status: 400 })
    ));
    await expect(
      client().request({
        baseUrl: 'https://api.storekit.apple.com',
        method: 'GET',
        path: '/inApps/v1/transactions/x',
        audience: 'storekit',
      })
    ).rejects.toThrow(/4000006.*Invalid transaction id/);
  });

  it('exposes status and detail on the error', async () => {
    server.use(http.get(`${BASE}/v1/apps`, () => HttpResponse.json({ errors: [{ status: '403' }] }, { status: 403 })));
    const err = await client().request(get()).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
  });
});

describe('auth refresh', () => {
  it('re-mints once on 401 and succeeds on the retry', async () => {
    let calls = 0;
    server.use(http.get(`${BASE}/v1/apps`, () => {
      calls += 1;
      return calls === 1
        ? HttpResponse.json({ errors: [{ status: '401' }] }, { status: 401 })
        : HttpResponse.json({ data: [{ id: 'ok' }] });
    }));
    const res = await client().request(get());
    expect(calls).toBe(2);
    expect((res.data as any).data[0].id).toBe('ok');
  });

  it('gives up after a second 401 rather than looping', async () => {
    let calls = 0;
    server.use(http.get(`${BASE}/v1/apps`, () => {
      calls += 1;
      return HttpResponse.json({ errors: [{ status: '401' }] }, { status: 401 });
    }));
    await expect(client().request(get())).rejects.toThrow();
    expect(calls).toBe(2);
  });
});

describe('retry policy', () => {
  it('retries a read on 503', async () => {
    let calls = 0;
    server.use(http.get(`${BASE}/v1/apps`, () => {
      calls += 1;
      return calls < 3 ? new HttpResponse(null, { status: 503 }) : HttpResponse.json({ data: [] });
    }));
    await client().request(get());
    expect(calls).toBe(3);
  });

  // Apple may already have applied a write that failed ambiguously; resending
  // it could duplicate the effect, which is worse than reporting a failure.
  it('does NOT retry a write on 503', async () => {
    let calls = 0;
    server.use(http.post(`${BASE}/v1/apps`, () => {
      calls += 1;
      return new HttpResponse(null, { status: 503 });
    }));
    await expect(client().request(get({ method: 'POST', body: {} }))).rejects.toThrow();
    expect(calls).toBe(1);
  });

  // A 429 is safe to resend: Apple rejected it before doing any work.
  it('does retry a write on 429', async () => {
    let calls = 0;
    server.use(http.post(`${BASE}/v1/apps`, () => {
      calls += 1;
      return calls < 2 ? new HttpResponse(null, { status: 429 }) : HttpResponse.json({ data: {} });
    }));
    await client().request(get({ method: 'POST', body: {} }));
    expect(calls).toBe(2);
  });

  it('marks a timed-out write as ambiguous instead of retrying it', async () => {
    server.use(http.post(`${BASE}/v1/apps`, async () => {
      await new Promise((r) => setTimeout(r, 300));
      return HttpResponse.json({});
    }));
    const err = await client(50).request(get({ method: 'POST', body: {} })).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.ambiguous).toBe(true);
    expect(err.message).toMatch(/may or may not have applied/);
  });
});

describe('pagination', () => {
  it('follows links.next and concatenates', async () => {
    server.use(
      http.get(`${BASE}/v1/apps`, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        return cursor === '2'
          ? HttpResponse.json({ data: [{ id: 'b' }] })
          : HttpResponse.json({ data: [{ id: 'a' }], links: { next: `${BASE}/v1/apps?cursor=2` } });
      })
    );
    const res = await client().requestAll(get(), 10);
    expect((res.data as any).count).toBe(2);
    expect((res.data as any).pages).toBe(2);
  });

  it('stops at the page cap', async () => {
    server.use(http.get(`${BASE}/v1/apps`, () =>
      HttpResponse.json({ data: [{ id: 'x' }], links: { next: `${BASE}/v1/apps?cursor=n` } })
    ));
    const res = await client().requestAll(get(), 3);
    expect((res.data as any).pages).toBe(3);
  });

  // The cursor is attacker-influenceable input, so it goes through the same
  // allowlist as any other URL.
  it('refuses a cursor pointing off Apple’s hosts', async () => {
    server.use(http.get(`${BASE}/v1/apps`, () =>
      HttpResponse.json({ data: [{ id: 'a' }], links: { next: 'https://evil.example.com/v1/apps' } })
    ));
    await expect(client().requestAll(get(), 5)).rejects.toThrow(/Refusing to send credentials/);
  });

  it('follows the StoreKit revision cursor while hasMore is set', async () => {
    let calls = 0;
    server.use(http.get('https://api.storekit.apple.com/inApps/v2/history/t', () => {
      calls += 1;
      return calls === 1
        ? HttpResponse.json({ hasMore: true, revision: 'r2', signedTransactions: [] })
        : HttpResponse.json({ hasMore: false, signedTransactions: [] });
    }));
    const res = await client().requestAll(
      { baseUrl: 'https://api.storekit.apple.com', method: 'GET', path: '/inApps/v2/history/t', audience: 'storekit' },
      5
    );
    expect((res.data as any).pages).toBe(2);
  });
});
