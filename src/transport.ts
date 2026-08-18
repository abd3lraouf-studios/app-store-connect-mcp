/**
 * stdio for local clients, Streamable HTTP for remote or containerised ones.
 *
 * The HTTP mode carries a risk the stdio mode does not: it turns a process
 * holding an App Store Connect signing key into something reachable over a
 * socket. Anyone who can reach it can change your pricing. So it binds to
 * loopback unless told otherwise, and it requires a bearer token — refusing to
 * start without one rather than defaulting to open.
 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Config } from './config.js';

export async function startStdio(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('app-store-connect-mcp ready on stdio');
}

export async function startHttp(config: Config, makeServer: () => Server): Promise<void> {
  if (!config.httpToken) {
    throw new Error(
      'HTTP transport requires a bearer token. Set ASC_HTTP_TOKEN (or --http-token).\n' +
        'This process can change App Store pricing; it must not listen unauthenticated.'
    );
  }
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    console.error(
      `WARNING: binding to ${config.host}, not loopback. The bearer token is the only thing ` +
        'between the network and your signing key. Prefer an SSH tunnel or a reverse proxy with TLS.'
    );
  }

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // DNS-rebinding protection. A page in the user's browser can resolve its own
  // domain to 127.0.0.1 and reach a loopback-bound server; the browser then
  // treats it as same-origin and the bearer token is not a defence, because a
  // rebound request comes from the user's own machine. Validating Host and
  // Origin is what actually stops it, and the MCP spec requires it.
  const allowedHosts = new Set([
    `${config.host}:${config.port}`,
    `localhost:${config.port}`,
    `127.0.0.1:${config.port}`,
    `[::1]:${config.port}`,
  ]);
  const allowedOrigins = new Set(
    (process.env.ASC_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean)
  );

  app.use('/mcp', (req, res, next) => {
    const host = req.headers.host;
    if (!host || !allowedHosts.has(host)) {
      res.status(403).json({ error: 'Forbidden: unexpected Host header' });
      return;
    }
    // A non-browser client sends no Origin at all; only reject one we were
    // given and do not recognise.
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      res.status(403).json({ error: 'Forbidden: origin not allowed' });
      return;
    }
    next();
  });

  // Constant-time-ish comparison; the token is short and compared per request.
  const expected = `Bearer ${config.httpToken}`;
  app.use('/mcp', (req, res, next) => {
    const provided = req.headers.authorization ?? '';
    if (provided.length !== expected.length || provided !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });

  const sessions = new Map<string, StreamableHTTPServerTransport>();

  app.post('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport = sessionId ? sessions.get(sessionId) : undefined;

      if (!transport) {
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
        await makeServer().connect(transport);
        transport.onclose = () => {
          if (transport?.sessionId) sessions.delete(transport.sessionId);
        };
      }

      await transport.handleRequest(req, res, req.body);
      if (transport.sessionId) sessions.set(transport.sessionId, transport);
    } catch (error) {
      console.error('MCP POST failed:', error);
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
  });

  const bySession = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? sessions.get(sessionId) : undefined;
    if (!transport) {
      res.status(404).json({ error: 'Unknown session' });
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get('/mcp', bySession);
  app.delete('/mcp', bySession);

  // Unauthenticated on purpose: liveness only, no account information.
  // Deliberately separate from /mcp — a POST there is a real protocol request
  // and a naive probe would be rejected by the header rules.
  app.get('/healthz', (_req, res) => res.json({ status: 'ok', sessions: sessions.size }));
  app.get('/health', (_req, res) => res.json({ status: 'ok', sessions: sessions.size }));

  await new Promise<void>((resolve) => {
    app.listen(config.port, config.host, () => {
      console.error(`app-store-connect-mcp ready on http://${config.host}:${config.port}/mcp`);
      resolve();
    });
  });
}
