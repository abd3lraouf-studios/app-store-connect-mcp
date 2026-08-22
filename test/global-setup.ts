/**
 * Build once, before any test file runs.
 *
 * Two suites drive the compiled output — stdio.test.ts spawns the real binary,
 * failure-log.test.ts spawns processes that import the compiled module — and
 * vitest runs files in parallel forks. Each doing its own `beforeAll` build
 * meant two `tsc` runs writing into `dist/` while a third process was executing
 * what they were overwriting: a flake that appears roughly one run in ten and
 * looks like nothing in particular.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export default function setup(): void {
  // Not via npm: on Windows, Node refuses to spawn a .cmd without a shell (the
  // CVE-2024-27980 fix), so `npm run build` fails there with EINVAL. Invoking
  // node directly is both cross-platform and faster.
  const run = (script: string, args: string[] = []) =>
    execFileSync(process.execPath, [script, ...args], { cwd: ROOT, stdio: 'pipe' });

  run('scripts/build-index.mjs');
  run(path.join('node_modules', 'typescript', 'bin', 'tsc'), ['-p', 'tsconfig.build.json']);
}
