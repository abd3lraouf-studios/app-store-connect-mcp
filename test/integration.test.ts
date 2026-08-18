/**
 * Integration through the real MCP protocol, driven in-process over
 * InMemoryTransport — no subprocess, no port, but every request and response
 * goes through the same code path a real client would use.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { generateKeyPairSync } from 'node:crypto';
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

const mock = setupServer();
beforeAll(() => mock.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mock.resetHandlers());
afterAll(() => mock.close());

const baseConfig: Config = {
  keyRef: privateKey as unknown as string,
  issuerId: 'issuer-uuid',
  keyId: 'ABC123KEYD',
  bundleId: 'com.example.app',
  safety: 'default',
  transport: 'stdio',
  host: '127.0.0.1',
  port: 8787,
  storekitEnvironment: 'Production',
};

async function connect(overrides: Partial<Config> = {}) {
  const server = createServer({ ...baseConfig, ...overrides });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => client.close() };
}

/** Tool results arrive as text content; unwrap and parse. */
function payload(result: any): any {
  const text = result.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

describe('tools/list', () => {
  it('exposes the expected tool set', async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'asc_call',
      'asc_describe_endpoint',
      'asc_search_endpoints',
      'asc_status',
    ]);
    await close();
  });

  it('gives every tool a description and an object input schema', async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.description && t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe('object');
    }
    await close();
  });

  // Older Claude Code versions skip a tool whose schema uses a combinator at
  // the root, which fails silently and invisibly.
  it('uses no root-level schema combinators', async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    for (const t of tools) {
      const s = t.inputSchema as Record<string, unknown>;
      expect(s.anyOf ?? s.oneOf ?? s.allOf).toBeUndefined();
    }
    await close();
  });
});

describe('asc_search_endpoints', () => {
  it('searches both APIs and routes a StoreKit phrase to StoreKit', async () => {
    const { client, close } = await connect();
    const out = payload(await client.callTool({ name: 'asc_search_endpoints', arguments: { query: 'transaction history' } }));
    expect(out.storekit.matched).toBeGreaterThan(0);
    await close();
  });

  it('finds Connect operations for a natural phrase', async () => {
    const { client, close } = await connect();
    const out = payload(await client.callTool({ name: 'asc_search_endpoints', arguments: { query: 'subscription price' } }));
    expect(out.connect.matched).toBeGreaterThan(0);
    await close();
  });
});

describe('asc_describe_endpoint', () => {
  it('describes a Connect operation with its risk tier', async () => {
    const { client, close } = await connect();
    const out = payload(await client.callTool({ name: 'asc_describe_endpoint', arguments: { operationId: 'appPriceSchedules_createInstance' } }));
    expect(out.risk).toBe('REVENUE');
    expect(out.riskMeaning).toMatch(/charged/);
    await close();
  });

  it('labels StoreKit responses as decoded-but-unverified', async () => {
    const { client, close } = await connect();
    const out = payload(await client.callTool({ name: 'asc_describe_endpoint', arguments: { operationId: 'storekit_getTransactionInfo' } }));
    expect(out.note).toMatch(/WITHOUT verifying/);
    await close();
  });
});

describe('asc_call', () => {
  it('performs a read', async () => {
    mock.use(http.get(`${BASE}/v1/apps`, () => HttpResponse.json({ data: [{ id: '1', attributes: { bundleId: 'com.x' } }] })));
    const { client, close } = await connect();
    const out = payload(await client.callTool({ name: 'asc_call', arguments: { operationId: 'apps_getCollection' } }));
    expect(out.data[0].attributes.bundleId).toBe('com.x');
    await close();
  });

  it('reports a missing path parameter as an error result', async () => {
    const { client, close } = await connect();
    const res = await client.callTool({ name: 'asc_call', arguments: { operationId: 'apps_getInstance' } });
    expect(res.isError).toBe(true);
    expect(payload(res).error).toMatch(/Missing required path parameter/);
    await close();
  });

  it('points an unknown operationId at the search tool', async () => {
    const { client, close } = await connect();
    const res = await client.callTool({ name: 'asc_call', arguments: { operationId: 'not_a_real_op' } });
    expect(payload(res).error).toMatch(/asc_search_endpoints/);
    await close();
  });

  it('maps a 401 to an actionable hint', async () => {
    mock.use(http.get(`${BASE}/v1/apps`, () => HttpResponse.json({ errors: [{ status: '401' }] }, { status: 401 })));
    const { client, close } = await connect();
    const out = payload(await client.callTool({ name: 'asc_call', arguments: { operationId: 'apps_getCollection' } }));
    expect(out.hint).toMatch(/asc_status/);
    await close();
  });
});

describe('the safety gate, end to end', () => {
  it('gates a DESTRUCTIVE call and then honours its token', async () => {
    let deleted = false;
    mock.use(http.delete(`${BASE}/v1/analyticsReportRequests/123`, () => {
      deleted = true;
      return new HttpResponse(null, { status: 204 });
    }));
    const { client, close } = await connect();
    const args = { operationId: 'analyticsReportRequests_deleteInstance', path_params: { id: '123' } };

    const gated = payload(await client.callTool({ name: 'asc_call', arguments: args }));
    expect(gated.confirmationRequired).toBe(true);
    expect(gated.risk).toBe('DESTRUCTIVE');
    expect(deleted).toBe(false);

    await client.callTool({ name: 'asc_call', arguments: { ...args, confirm: gated.token } });
    expect(deleted).toBe(true);
    await close();
  });

  it('rejects a forged token', async () => {
    const { client, close } = await connect();
    const res = await client.callTool({
      name: 'asc_call',
      arguments: { operationId: 'analyticsReportRequests_deleteInstance', path_params: { id: '1' }, confirm: 'forged' },
    });
    expect(payload(res).blocked).toBe(true);
    await close();
  });

  it('blocks every write in read-only mode', async () => {
    const { client, close } = await connect({ safety: 'read-only' });
    const res = await client.callTool({
      name: 'asc_call',
      arguments: { operationId: 'analyticsReportRequests_deleteInstance', path_params: { id: '1' } },
    });
    expect(payload(res).message).toMatch(/read-only/);
    await close();
  });

  it('executes without confirmation in no-confirm mode', async () => {
    let deleted = false;
    mock.use(http.delete(`${BASE}/v1/analyticsReportRequests/9`, () => {
      deleted = true;
      return new HttpResponse(null, { status: 204 });
    }));
    const { client, close } = await connect({ safety: 'no-confirm' });
    await client.callTool({
      name: 'asc_call',
      arguments: { operationId: 'analyticsReportRequests_deleteInstance', path_params: { id: '9' } },
    });
    expect(deleted).toBe(true);
    await close();
  });
});

describe('asc_status', () => {
  it('reports credentials and both catalogues', async () => {
    mock.use(http.get(`${BASE}/v1/apps`, () => HttpResponse.json({ data: [{ attributes: { bundleId: 'com.x' } }] })));
    const { client, close } = await connect();
    const out = payload(await client.callTool({ name: 'asc_status', arguments: {} }));
    expect(out.connected).toBe(true);
    expect(out.keyId).toBe('ABC123KEYD');
    expect(out.connectApi.operations).toBeGreaterThan(1200);
    expect(out.storeKitApi.operations).toBe(30);
    await close();
  });

  // The key must never appear in output a model or a log can see.
  it('never leaks key material', async () => {
    mock.use(http.get(`${BASE}/v1/apps`, () => HttpResponse.json({ data: [] })));
    const { client, close } = await connect();
    const res = await client.callTool({ name: 'asc_status', arguments: {} });
    expect(JSON.stringify(res)).not.toContain('BEGIN PRIVATE KEY');
    await close();
  });
});
