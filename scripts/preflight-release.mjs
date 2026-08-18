#!/usr/bin/env node
/**
 * Refuse to publish a release that contradicts itself.
 *
 * The failure this prevents is mundane and embarrassing: a tag, a
 * package.json and a README that disagree about the version, or a README
 * advertising a tool count the code no longer has. Both drift silently,
 * because nothing else reads them together.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const problems = [];
const pkg = JSON.parse(read('package.json'));

// 1. The git tag, when there is one, must match package.json.
const tag = (process.env.GITHUB_REF ?? '').replace('refs/tags/', '');
if (tag && tag !== `v${pkg.version}`) {
  problems.push(`Tag ${tag} does not match package.json version ${pkg.version}.`);
}

// 2. Operation counts advertised in the README must match the code.
const index = JSON.parse(read('spec/index.json'));
// Taken from the artifact parsed out of Apple's own client rather than by
// counting braces in the source; a contract test already asserts the two agree.
const storekitCount = JSON.parse(read('spec/storekit-endpoints.json')).operationCount;
const total = index.operationCount + storekitCount;
const readme = read('README.md');

for (const [label, value] of [
  ['Connect operation count', index.operationCount],
  ['total operation count', total],
]) {
  const withCommas = value.toLocaleString('en-US');
  if (!readme.includes(String(value)) && !readme.includes(withCommas)) {
    problems.push(`README does not mention the ${label} (${withCommas}).`);
  }
}

// 3. The advertised tool count must match the code. This is the drift that
//    just slipped through: the README said "four tools" after a fifth existed.
// Tools come from two places: the core ones declared inline in the server,
// and the composite ones contributed by the macro registry. Counting only the
// first is how this check went stale the moment macros landed.
const coreTools = [...read('src/server.ts').matchAll(/^\s{8}name: '(asc_[a-z_]+)',$/gm)].map((m) => m[1]);
const macroTools = [...read('src/macros/index.ts').matchAll(/^\s{4}name: '(asc_[a-z_]+)',$/gm)].map((m) => m[1]);
const toolNames = [...new Set([...coreTools, ...macroTools])];
const words = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight' };
if (!toolNames.length) {
  problems.push('Could not determine the tool count from src/server.ts — the pre-flight check needs updating.');
} else {
  const word = words[toolNames.length];
  if (!readme.includes(`${word} tools`) && !readme.includes(`${toolNames.length} tools`)) {
    problems.push(`README does not advertise ${toolNames.length} (${word}) tools; found: ${toolNames.join(', ')}.`);
  }
  for (const t of toolNames) {
    if (!readme.includes(t)) problems.push(`README never mentions the tool ${t}.`);
  }
}

// 4. The spec index must be current with respect to the spec it came from.
const specVersion = JSON.parse(read('spec/apple-openapi.json')).info.version;
if (index.apiVersion !== specVersion) {
  problems.push(`spec/index.json is built from v${index.apiVersion} but the spec is v${specVersion}. Run: npm run build:index`);
}

if (problems.length) {
  console.error('Release pre-flight failed:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}

console.log(
  `Pre-flight OK — v${pkg.version}, ${index.operationCount} Connect + ${storekitCount} StoreKit ` +
    `= ${total} operations across ${toolNames.length} tools, spec v${specVersion}.`
);
