#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { startHttp, startStdio } from './transport.js';
import { activeCount, whenIdle } from './inflight.js';

const HELP = `app-store-connect-mcp — App Store Connect + App Store Server (StoreKit 2) over MCP

Credentials (one of, in order of preference):
  ASC_KEY=keychain:<service>[/<account>]   macOS Keychain. The envelope may carry
                                           issuer and key IDs alongside the key.
  ASC_PRIVATE_KEY_PATH=/path/AuthKey.p8    A .p8 on disk.
  ASC_PRIVATE_KEY=<pem>                    Inline. Visible via 'ps -E'; avoid.

  ASC_ISSUER_ID, ASC_KEY_ID                Required unless the Keychain envelope has them.
  ASC_BUNDLE_ID                            Required for App Store Server API calls.

Safety:
  --read-only     Block every mutating operation.
  --confirm       Require confirmation for every write.
  --no-confirm    Execute writes immediately.
  (default)       Confirm REVENUE, DESTRUCTIVE, INFRASTRUCTURE, ACCESS, RELEASE.

Transport:
  --transport stdio|http     Default stdio.
  --host, --port             Default 127.0.0.1:8787.
  --http-token <token>       Required for http (ASC_HTTP_TOKEN).

Other:
  --storekit-env Production|Sandbox
`;

/**
 * Exit when the parent goes away — but finish answering first.
 *
 * The stdio transport's lifetime is the parent's lifetime, and nothing in the
 * SDK enforces that: if the client dies without closing cleanly, stdin hits EOF
 * and an unwatched server keeps running, reparented to init, holding a signing
 * key.
 *
 * EOF is not the same as "stop working", though. It means no *further*
 * requests are coming; anything already running still deserves its reply.
 * Exiting the moment stdin closes drops the response to a slow call — and any
 * piped or batched input triggers exactly that, because the pipe drains long
 * before the work does. So EOF drains, while a signal is a real instruction to
 * stop and gets a much shorter grace period.
 */
const DRAIN_MS = 120_000;
const SIGNAL_GRACE_MS = 2_000;

/**
 * process.exit() abandons buffered stdout writes. On a pipe that is exactly
 * where the last response sits, so the reply we just spent the drain waiting
 * for would be discarded at the final step.
 */
function flushStdout(): Promise<void> {
  return new Promise((resolve) => {
    if (!process.stdout.writableLength) {
      setImmediate(resolve);
      return;
    }
    process.stdout.write('', () => setImmediate(resolve));
  });
}

function installShutdownHandlers(): void {
  let closing = false;
  const shutdown = (reason: string, graceMs: number) => {
    if (closing) return;
    closing = true;
    const pending = activeCount();
    if (pending) {
      console.error(`app-store-connect-mcp: ${reason}; finishing ${pending} in-flight request(s)`);
    }
    void whenIdle(graceMs)
      .then(flushStdout)
      .then(() => {
        console.error(`app-store-connect-mcp: shutting down (${reason})`);
        process.exit(0);
      });
  };

  process.stdin.on('end', () => shutdown('stdin closed', DRAIN_MS));
  process.stdin.on('close', () => shutdown('stdin closed', DRAIN_MS));
  process.on('SIGTERM', () => shutdown('SIGTERM', SIGNAL_GRACE_MS));
  process.on('SIGINT', () => shutdown('SIGINT', SIGNAL_GRACE_MS));
  process.on('SIGHUP', () => shutdown('SIGHUP', SIGNAL_GRACE_MS));
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }

  const config = loadConfig();

  if (config.transport === 'http') {
    await startHttp(config, () => createServer(config));
  } else {
    installShutdownHandlers();
    await startStdio(createServer(config));
  }
}

main().catch((error) => {
  console.error(`app-store-connect-mcp: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
