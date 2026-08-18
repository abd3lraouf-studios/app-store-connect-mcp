/**
 * Credential resolution.
 *
 * The private key is an ES256 App Store Connect API key. Apple lets you
 * download the .p8 exactly once, so treat the copy you have as irreplaceable
 * and keep it out of plain text wherever possible.
 *
 * Three sources, in descending order of preference:
 *
 *   keychain:<service>[/<account>]   macOS Keychain. Recommended.
 *   /path/to/AuthKey.p8              A file on disk. Fine, but it is plain text.
 *   ASC_PRIVATE_KEY=<pem>            Inline. Discouraged — `ps -E` shows the
 *                                    environment of your own processes to any
 *                                    other process running as you.
 *
 * A Keychain item may hold either a bare PEM or a base64 JSON envelope of the
 * form { issuerID, keyID, privateKeyPEM }. The envelope is worth preferring:
 * it carries the key's own identifiers, so `issuerId`/`keyId` are read from the
 * same place as the key material and cannot fall out of sync with it. Config
 * drift of exactly that kind is a silent 401 that looks like a broken server.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export const KEYCHAIN_SCHEME = 'keychain:';

export interface Credentials {
  privateKey: string;
  issuerId: string;
  keyId: string;
  /** Where the key came from, for `asc_status`. Never includes key material. */
  source: string;
}

export interface CredentialInput {
  keyRef: string;
  issuerId?: string;
  keyId?: string;
}

interface KeychainPayload {
  privateKeyPEM?: string;
  issuerID?: string;
  keyID?: string;
}

function readKeychain(ref: string): { pem: string; issuerId?: string; keyId?: string; source: string } {
  const [service, account] = ref.slice(KEYCHAIN_SCHEME.length).split('/');
  if (!service) {
    throw new Error(`Malformed keychain reference "${ref}". Expected keychain:<service>[/<account>].`);
  }

  const args = ['find-generic-password', '-s', service, '-w'];
  if (account) args.push('-a', account);

  let raw: string;
  try {
    // The secret comes back on stdout. Never pass it as an argument.
    raw = execFileSync('security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    throw new Error(
      `No keychain item for service "${service}"${account ? ` account "${account}"` : ''}. ` +
        `Inspect it with: security find-generic-password -s ${service}`
    );
  }

  // Envelope first, bare PEM as the fallback.
  let payload: KeychainPayload | undefined;
  try {
    payload = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as KeychainPayload;
  } catch {
    payload = undefined;
  }

  const pem = payload?.privateKeyPEM ?? (raw.includes('BEGIN') ? raw : undefined);
  if (!pem?.includes('BEGIN')) {
    throw new Error(
      `Keychain item "${service}" holds no PEM private key. Expected either a bare ` +
        `PEM or base64 JSON with a privateKeyPEM field.`
    );
  }

  return {
    pem,
    issuerId: payload?.issuerID,
    keyId: payload?.keyID,
    source: `keychain:${service}${account ? `/${account}` : ''}`,
  };
}

export const NO_KEY_MESSAGE =
  'No API key configured. Set one of:\n' +
  `  ASC_KEY=${KEYCHAIN_SCHEME}<service>   (recommended — macOS Keychain)\n` +
  '  ASC_PRIVATE_KEY_PATH=/path/AuthKey.p8\n' +
  '  ASC_PRIVATE_KEY=<pem>                 (discouraged; visible via ps -E)';

export function resolveCredentials(input: CredentialInput): Credentials {
  if (!input.keyRef) throw new Error(NO_KEY_MESSAGE);

  let pem: string;
  let issuerId = input.issuerId;
  let keyId = input.keyId;
  let source: string;

  if (input.keyRef.startsWith(KEYCHAIN_SCHEME)) {
    const kc = readKeychain(input.keyRef);
    pem = kc.pem;
    source = kc.source;
    // Identifiers stored beside the key win: they are guaranteed to match it.
    issuerId = kc.issuerId ?? issuerId;
    keyId = kc.keyId ?? keyId;
  } else if (input.keyRef.startsWith('-----BEGIN')) {
    pem = input.keyRef;
    source = 'inline env (ASC_PRIVATE_KEY)';
  } else {
    if (!fs.existsSync(input.keyRef)) {
      throw new Error(`Private key file not found: ${input.keyRef}`);
    }
    pem = fs.readFileSync(input.keyRef, 'utf8');
    source = `file:${input.keyRef}`;
  }

  if (!issuerId) throw new Error('Missing issuer ID. Set ASC_ISSUER_ID or store it in the keychain envelope.');
  if (!keyId) throw new Error('Missing key ID. Set ASC_KEY_ID or store it in the keychain envelope.');

  return {
    privateKey: pem.endsWith('\n') ? pem : `${pem}\n`,
    issuerId,
    keyId,
    source,
  };
}
