#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { startHttp, startStdio } from './transport.js';

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
 * Exit when the parent goes away.
 *
 * The stdio transport's lifetime is the parent's lifetime, but nothing in the
 * SDK enforces that: if the client dies without closing cleanly, stdin hits EOF
 * and an unwatched server keeps running, reparented to init. Watching EOF and
 * the termination signals is what stops this turning into an orphan holding a
 * signing key.
 */
function installShutdownHandlers(): void {
  let closing = false;
  const shutdown = (reason: string) => {
    if (closing) return;
    closing = true;
    console.error(`app-store-connect-mcp: shutting down (${reason})`);
    process.exit(0);
  };

  process.stdin.on('end', () => shutdown('stdin closed'));
  process.stdin.on('close', () => shutdown('stdin closed'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
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
