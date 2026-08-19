#!/usr/bin/env node
/**
 * Bump the version everywhere it is written down.
 *
 * The version lives in package.json, package-lock.json and twice in
 * server.json. Editing them by hand is how a release ends up advertising a
 * version to the MCP Registry that does not exist on npm — which the
 * pre-flight now catches, but only after you have already pushed.
 *
 *   node scripts/bump-version.mjs 1.1.0
 *   node scripts/bump-version.mjs patch|minor|major
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = process.argv[2];

if (!arg) {
  console.error('Usage: node scripts/bump-version.mjs <version|patch|minor|major>');
  process.exit(1);
}

const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const current = pkg.version;

function next(from, kind) {
  const [major, minor, patch] = from.split('.').map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(kind)) {
    throw new Error(`"${kind}" is not a version or one of patch|minor|major.`);
  }
  return kind;
}

const version = next(current, arg);
if (version === current) {
  console.error(`Already at ${current}; nothing to do.`);
  process.exit(1);
}

// npm keeps package-lock.json in step for us.
execFileSync('npm', ['version', version, '--no-git-tag-version'], { cwd: ROOT, stdio: 'pipe' });

const serverPath = path.join(ROOT, 'server.json');
const server = JSON.parse(fs.readFileSync(serverPath, 'utf8'));
server.version = version;
for (const p of server.packages ?? []) p.version = version;
fs.writeFileSync(serverPath, `${JSON.stringify(server, null, 2)}\n`);

console.log(`${current} → ${version}`);
console.log('  package.json, package-lock.json, server.json');
console.log('\nNext: commit and merge to main. CI publishes to npm and the MCP Registry.');
