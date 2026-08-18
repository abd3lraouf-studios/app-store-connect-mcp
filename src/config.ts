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
  /** Numeric Apple ID. Apple requires it to verify Production signatures. */
  appAppleId?: number;
  /** OCSP revocation checks during signature verification. */
  onlineChecks: boolean;
  safety: SafetyMode;
  transport: 'stdio' | 'http';
  host: string;
  port: number;
  /** Bearer token required by the HTTP transport. */
  httpToken?: string;
  storekitEnvironment: 'Production' | 'Sandbox';
  /** Mask tester names and email local-parts, keeping the domain. */
  redactPii: boolean;
}

function flag(argv: string[], name: string): string | undefined {
  const exact = argv.indexOf(`--${name}`);
  const following = exact === -1 ? undefined : argv[exact + 1];
  if (following && !following.startsWith('--')) return following;
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
    appAppleId: (() => {
      const raw = flag(argv, 'app-apple-id') ?? process.env.ASC_APP_APPLE_ID;
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) && n > 0 ? n : undefined;
    })(),
    onlineChecks: !has(argv, 'no-online-checks') && process.env.ASC_NO_ONLINE_CHECKS !== '1',
    safety,
    transport,
    // Loopback by default: this process holds a key that can change pricing.
    // Binding it to every interface should be a deliberate act.
    host: flag(argv, 'host') ?? process.env.ASC_HTTP_HOST ?? '127.0.0.1',
    port: Number(flag(argv, 'port') ?? process.env.ASC_HTTP_PORT ?? 8787),
    httpToken: flag(argv, 'http-token') ?? process.env.ASC_HTTP_TOKEN,
    redactPii: has(argv, 'redact-pii') || process.env.ASC_REDACT_PII === '1',
    storekitEnvironment:
      (flag(argv, 'storekit-env') ?? process.env.ASC_STOREKIT_ENV ?? 'Production') === 'Sandbox'
        ? 'Sandbox'
        : 'Production',
  };
}
