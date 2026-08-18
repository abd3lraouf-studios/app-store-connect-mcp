/**
 * Configuration from flags and environment, flags winning.
 */
import { KEYCHAIN_SCHEME } from './credentials.js';
import type { SafetyMode } from './safety.js';

export interface Config {
  keyRef: string;
  issuerId?: string;
  keyId?: string;
  bundleId?: string;
  safety: SafetyMode;
  transport: 'stdio' | 'http';
  host: string;
  port: number;
  /** Bearer token required by the HTTP transport. */
  httpToken?: string;
  storekitEnvironment: 'Production' | 'Sandbox';
}

function flag(argv: string[], name: string): string | undefined {
  const exact = argv.indexOf(`--${name}`);
  if (exact !== -1 && argv[exact + 1] && !argv[exact + 1].startsWith('--')) return argv[exact + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

function has(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  const keyRef =
    flag(argv, 'key') ??
    process.env.ASC_KEY ??
    process.env.ASC_PRIVATE_KEY_PATH ??
    process.env.ASC_PRIVATE_KEY ??
    '';

  if (!keyRef) {
    throw new Error(
      'No API key configured. Set one of:\n' +
        `  ASC_KEY=${KEYCHAIN_SCHEME}<service>   (recommended — macOS Keychain)\n` +
        '  ASC_PRIVATE_KEY_PATH=/path/AuthKey.p8\n' +
        '  ASC_PRIVATE_KEY=<pem>                 (discouraged; visible via ps -E)'
    );
  }

  let safety: SafetyMode = 'default';
  if (has(argv, 'read-only')) safety = 'read-only';
  else if (has(argv, 'confirm')) safety = 'confirm';
  else if (has(argv, 'no-confirm')) safety = 'no-confirm';

  const transport = (flag(argv, 'transport') ?? (has(argv, 'http') ? 'http' : 'stdio')) as 'stdio' | 'http';

  return {
    keyRef,
    issuerId: flag(argv, 'issuer-id') ?? process.env.ASC_ISSUER_ID,
    keyId: flag(argv, 'key-id') ?? process.env.ASC_KEY_ID,
    bundleId: flag(argv, 'bundle-id') ?? process.env.ASC_BUNDLE_ID,
    safety,
    transport,
    // Loopback by default: this process holds a key that can change pricing.
    // Binding it to every interface should be a deliberate act.
    host: flag(argv, 'host') ?? process.env.ASC_HTTP_HOST ?? '127.0.0.1',
    port: Number(flag(argv, 'port') ?? process.env.ASC_HTTP_PORT ?? 8787),
    httpToken: flag(argv, 'http-token') ?? process.env.ASC_HTTP_TOKEN,
    storekitEnvironment:
      (flag(argv, 'storekit-env') ?? process.env.ASC_STOREKIT_ENV ?? 'Production') === 'Sandbox'
        ? 'Sandbox'
        : 'Production',
  };
}
