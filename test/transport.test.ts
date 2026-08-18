/**
 * The HTTP transport carries the security controls, so it is tested against a
 * real listener on an ephemeral loopback port. Nothing here reaches Apple.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import { startHttp } from '../src/transport.js';
import { createServer } from '../src/server.js';
import type { Config } from '../src/config.js';

const { privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const PORT = 8899;
const TOKEN = 'test-token-value';

const config: Config = {
  keyRef: privateKey,
  issuerId: 'issuer-uuid',
  keyId: 'ABC123KEYD',
  bundleId: 'com.example.app',
  safety: 'default',
  transport: 'http',
  host: '127.0.0.1',
  port: PORT,
  httpToken: TOKEN,
  onlineChecks: false,
  redactPii: false,
  storekitEnvironment: 'Production',
};

const url = `http://127.0.0.1:${PORT}`;

/** POST /mcp with an arbitrary Host header, which fetch refuses to send. */
function rawPost(hostHeader: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/mcp',
        method: 'POST',
        headers: {
          Host: hostHeader,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${TOKEN}`,
          'Content-Length': 2,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', reject);
    req.end('{}');
  });
}

describe('startup refusal', () => {
  // This process can change App Store pricing; it must not listen openly.
  it('refuses to start without a bearer token', async () => {
    await expect(startHttp({ ...config, httpToken: undefined }, () => createServer(config))).rejects.toThrow(
      /requires a bearer token/
    );
  });
});

describe('a running server', () => {
  beforeAll(async () => {
    await startHttp(config, () => createServer(config));
  });
  // Express has no exposed close handle here; the forked worker exits with the
  // suite, which is why vitest runs pool: 'forks'.
  afterAll(() => {});

  it('answers /healthz without authentication', async () => {
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).status).toBe('ok');
  });

  it('rejects an unauthenticated MCP request', async () => {
    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('rejects a wrong bearer token', async () => {
    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token-xx' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  // DNS rebinding: a page that resolves its own domain to 127.0.0.1 reaches
  // this server as same-origin, so the token alone is not a defence.
  //
  // fetch() cannot express this test — Host is a forbidden header name and
  // undici silently replaces it — so the request is made at the raw HTTP level.
  it('rejects an unexpected Host header before checking auth', async () => {
    const { status, body } = await rawPost('evil.example.com');
    expect(status).toBe(403);
    expect(JSON.parse(body).error).toMatch(/Host/);
  });

  it('accepts the loopback Host it is actually bound to', async () => {
    const { status } = await rawPost(`127.0.0.1:${PORT}`);
    expect(status).not.toBe(403);
  });

  it('rejects an Origin that was not allowlisted', async () => {
    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example.com',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toMatch(/origin/i);
  });

  it('accepts a correctly authenticated initialize and returns a session', async () => {
    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });

  it('404s an unknown session on GET', async () => {
    const res = await fetch(`${url}/mcp`, {
      headers: { Authorization: `Bearer ${TOKEN}`, 'mcp-session-id': 'no-such-session' },
    });
    expect(res.status).toBe(404);
  });
});
