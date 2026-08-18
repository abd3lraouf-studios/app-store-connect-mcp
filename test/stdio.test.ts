/**
 * The one test that must spawn the real binary.
 *
 * On stdio, stdout IS the JSON-RPC channel. A single stray console.log — in
 * our code or in a dependency — puts an unparseable line ahead of the response
 * and breaks every client. No in-process harness can catch that, because the
 * transport is mocked away.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENTRY = path.join(ROOT, 'dist/index.js');

const { privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'pipe' });
}, 180_000);

const env = {
  ...process.env,
  ASC_KEY: privateKey as unknown as string,
  ASC_ISSUER_ID: 'issuer-uuid',
  ASC_KEY_ID: 'ABC123KEYD',
  ASC_BUNDLE_ID: 'com.example.app',
};

/** Drive the real binary over stdio and collect both streams. */
function run(lines: string[], timeoutMs = 20_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [ENTRY], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out; stdout so far: ${stdout}`));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.write(lines.map((l) => `${l}\n`).join(''));
    child.stdin.end();
  });
}

const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
});
const READY = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
const LIST = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

describe('stdio transport', () => {
  it('emits nothing on stdout that is not JSON-RPC', async () => {
    const { stdout } = await run([INIT, READY, LIST]);
    const lines = stdout.split('\n').filter((l) => l.trim());
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('answers initialize and tools/list', async () => {
    const { stdout } = await run([INIT, READY, LIST]);
    const messages = stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    expect(messages.find((m) => m.id === 1)?.result.serverInfo.name).toBe('app-store-connect-mcp');
    expect(messages.find((m) => m.id === 2)?.result.tools.length).toBe(4);
  });

  it('logs its banner to stderr, never stdout', async () => {
    const { stderr } = await run([INIT, READY, LIST]);
    expect(stderr).toMatch(/ready on stdio/);
  });

  // Otherwise the process is reparented to init and lingers holding a key.
  it('exits when stdin closes rather than lingering', async () => {
    const { code } = await run([INIT, READY, LIST]);
    expect(code).toBe(0);
  });

  it('prints help and exits cleanly', () => {
    const out = execFileSync('node', [ENTRY, '--help'], { encoding: 'utf8' });
    expect(out).toMatch(/keychain:<service>/);
    expect(out).toMatch(/--read-only/);
  });

  it('fails with a usable message when no credentials are configured', () => {
    const bare = { ...process.env };
    delete bare.ASC_KEY;
    delete bare.ASC_PRIVATE_KEY_PATH;
    delete bare.ASC_PRIVATE_KEY;
    try {
      execFileSync('node', [ENTRY], { env: bare, encoding: 'utf8', stdio: 'pipe', timeout: 15_000 });
      throw new Error('expected a non-zero exit');
    } catch (e: any) {
      expect(String(e.stderr ?? '')).toMatch(/No API key configured/);
    }
  });
});
