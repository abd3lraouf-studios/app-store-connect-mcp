/**
 * Elicitation is the better confirmation mechanism because the person, not the
 * model, makes the decision. It is also the one most likely to fail quietly:
 * a client can declare the capability and still be unable to answer, and that
 * must never become a way past the gate.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { generateKeyPairSync } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
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

const DELETE_ARGS = { operationId: 'analyticsReportRequests_deleteInstance', path_params: { id: '7' } };

/** A client that declares elicitation and answers however the test says. */
async function connectWithElicitation(answer: (msg: string) => { action: string; content?: unknown }) {
  const server = createServer(config);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: { elicitation: {} } });
  const seen: string[] = [];
  client.setRequestHandler(ElicitRequestSchema, (req) => {
    seen.push((req.params as any).message);
    return answer((req.params as any).message);
  });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, seen, close: () => client.close() };
}

const payload = (r: any) => JSON.parse(r.content[0].text);

describe('with an elicitation-capable client', () => {
  it('asks the user, and proceeds when they accept', async () => {
    let deleted = false;
    mock.use(http.delete(`${BASE}/v1/analyticsReportRequests/7`, () => {
      deleted = true;
      return new HttpResponse(null, { status: 204 });
    }));
    const { client, seen, close } = await connectWithElicitation(() => ({
      action: 'accept',
      content: { confirmed: true },
    }));
    await client.callTool({ name: 'asc_write', arguments: DELETE_ARGS });
    expect(deleted).toBe(true);
    expect(seen[0]).toMatch(/DESTRUCTIVE/);
    expect(seen[0]).toMatch(/DELETE \/v1\/analyticsReportRequests\/7/);
    await close();
  });

  it('does not send anything when the user declines', async () => {
    // No handler registered: a request would fail the test outright.
    const { client, close } = await connectWithElicitation(() => ({ action: 'decline' }));
    const res = await client.callTool({ name: 'asc_write', arguments: DELETE_ARGS });
    expect(payload(res).blocked).toBe(true);
    expect(payload(res).message).toMatch(/declined/);
    await close();
  });

  it('treats an accept-without-confirmation as a refusal', async () => {
    const { client, close } = await connectWithElicitation(() => ({
      action: 'accept',
      content: { confirmed: false },
    }));
    const res = await client.callTool({ name: 'asc_write', arguments: DELETE_ARGS });
    expect(payload(res).blocked).toBe(true);
    await close();
  });

  it('does not prompt for a plain read', async () => {
    mock.use(http.get(`${BASE}/v1/apps`, () => HttpResponse.json({ data: [] })));
    const { client, seen, close } = await connectWithElicitation(() => ({ action: 'accept', content: { confirmed: true } }));
    await client.callTool({ name: 'asc_call', arguments: { operationId: 'apps_getCollection' } });
    expect(seen).toHaveLength(0);
    await close();
  });

  // A client that advertises the capability but cannot serve it must fall back
  // to the token, not sail through.
  it('falls back to the token handshake when the client errors', async () => {
    const { client, close } = await connectWithElicitation(() => {
      throw new Error('this client cannot render a form');
    });
    const res = payload(await client.callTool({ name: 'asc_write', arguments: DELETE_ARGS }));
    expect(res.confirmationRequired).toBe(true);
    expect(res.token).toBeTruthy();
    await close();
  });

  it('reports elicitation support in asc_status', async () => {
    mock.use(http.get(`${BASE}/v1/apps`, () => HttpResponse.json({ data: [] })));
    const { client, close } = await connectWithElicitation(() => ({ action: 'accept', content: { confirmed: true } }));
    const out = payload(await client.callTool({ name: 'asc_status', arguments: {} }));
    expect(out.elicitation).toMatch(/supported/);
    await close();
  });
});

describe('without elicitation', () => {
  it('uses the token handshake and says so in asc_status', async () => {
    mock.use(http.get(`${BASE}/v1/apps`, () => HttpResponse.json({ data: [] })));
    const server = createServer(config);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(st), client.connect(ct)]);

    const status = payload(await client.callTool({ name: 'asc_status', arguments: {} }));
    expect(status.elicitation).toMatch(/unavailable/);

    const gated = payload(await client.callTool({ name: 'asc_write', arguments: DELETE_ARGS }));
    expect(gated.confirmationRequired).toBe(true);
    await client.close();
  });
});

// --no-confirm has to switch off every layer, not just the token. An
// elicitation-capable client would otherwise still be asked, and Claude Code
// would still stop on the requiresUserInteraction flag — two confirmations
// for a run that asked for none.
describe('with --no-confirm', () => {
  const unattended: Config = { ...config, safety: 'no-confirm' };

  async function connectUnattended(elicitation: boolean) {
    const server = createServer(unattended);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: 'test', version: '1.0.0' },
      { capabilities: elicitation ? { elicitation: {} } : {} }
    );
    let asked = 0;
    if (elicitation) {
      client.setRequestHandler(ElicitRequestSchema, () => {
        asked += 1;
        return { action: 'decline' };
      });
    }
    await Promise.all([server.connect(st), client.connect(ct)]);
    return { client, asked: () => asked, close: () => client.close() };
  }

  it('sends a DESTRUCTIVE write without asking an elicitation-capable client', async () => {
    let deleted = false;
    mock.use(http.delete(`${BASE}/v1/analyticsReportRequests/7`, () => {
      deleted = true;
      return new HttpResponse(null, { status: 204 });
    }));
    const { client, asked, close } = await connectUnattended(true);
    const res = await client.callTool({ name: 'asc_write', arguments: DELETE_ARGS });
    expect(res.isError).toBeFalsy();
    expect(deleted).toBe(true);
    expect(asked()).toBe(0);
    await close();
  });

  it('issues no token when the client has no elicitation either', async () => {
    let deleted = false;
    mock.use(http.delete(`${BASE}/v1/analyticsReportRequests/7`, () => {
      deleted = true;
      return new HttpResponse(null, { status: 204 });
    }));
    const { client, close } = await connectUnattended(false);
    const res = payload(await client.callTool({ name: 'asc_write', arguments: DELETE_ARGS }));
    expect(res.confirmationRequired).toBeUndefined();
    expect(deleted).toBe(true);
    await close();
  });

  it('drops requiresUserInteraction from every write tool', async () => {
    const { client, close } = await connectUnattended(true);
    const { tools } = await client.listTools();
    const flagged = tools.filter((t) => (t as any)._meta?.['anthropic/requiresUserInteraction']);
    expect(flagged.map((t) => t.name)).toEqual([]);
    // The read/write split itself is untouched.
    expect(tools.find((t) => t.name === 'asc_write')?.annotations?.readOnlyHint).toBe(false);
    await close();
  });

  it('says so in asc_status', async () => {
    mock.use(http.get(`${BASE}/v1/apps`, () => HttpResponse.json({ data: [] })));
    const { client, close } = await connectUnattended(true);
    const out = payload(await client.callTool({ name: 'asc_status', arguments: {} }));
    expect(out.elicitation).toMatch(/bypassed/);
    expect(out.safetyMode).toMatch(/no-confirm/);
    await close();
  });
});
