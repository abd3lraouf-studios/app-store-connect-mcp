#!/usr/bin/env node
/**
 * Install the app-store-connect skill into a Claude Code skills directory.
 *
 *   node scripts/install-skill.mjs                 # copy into ~/.claude/skills
 *   node scripts/install-skill.mjs --link          # symlink it (development)
 *   node scripts/install-skill.mjs --scope project # into ./.claude/skills
 *
 * The only state this leaves behind, beyond the skill itself, is
 * `<skillDir>/.install.json`. That file is how the failure log knows which
 * checkout to write into on this machine and nothing about anyone else's: it
 * records a checkout path only when the package it was installed from actually
 * is one.
 *
 * It deliberately does not touch settings.json. The skill pre-approves its own
 * logging script through `allowed-tools` in its frontmatter, which is portable
 * and costs no global configuration.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKILL_NAME = 'app-store-connect';
const SOURCE = path.join(ROOT, 'skills', SKILL_NAME);

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(`--${flag}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

if (has('help') || has('h')) {
  process.stdout.write(
    'Usage: node scripts/install-skill.mjs [--scope user|project] [--link] [--force]\n\n' +
      '  --scope user     ~/.claude/skills (default)\n' +
      '  --scope project  ./.claude/skills\n' +
      '  --link           symlink instead of copying, so repo edits are live\n' +
      '  --force          replace a directory that is not a previous install\n'
  );
  process.exit(0);
}

const scope = value('scope', 'user');
if (scope !== 'user' && scope !== 'project') {
  console.error(`Unknown --scope "${scope}". Use user or project.`);
  process.exit(2);
}

const skillsDir =
  scope === 'user'
    ? path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'skills')
    : path.join(process.cwd(), '.claude', 'skills');
const target = path.join(skillsDir, SKILL_NAME);

if (!fs.existsSync(path.join(SOURCE, 'SKILL.md'))) {
  console.error(`No skill found at ${SOURCE}.`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const entry = path.join(ROOT, 'dist', 'failure-log.js');
if (!fs.existsSync(entry)) {
  console.error(`Warning: ${entry} is missing — run "npm run build" so failure logging has something to call.`);
}

/**
 * A checkout, not an installed copy. `files` ships neither src/ nor .git, so
 * requiring both is a fact about what npm publishes rather than a guess.
 */
const isCheckout =
  !ROOT.split(path.sep).includes('node_modules') &&
  fs.existsSync(path.join(ROOT, 'src')) &&
  fs.existsSync(path.join(ROOT, '.git'));

// Replacing something that is not a previous install of this skill is not ours
// to decide silently.
const existing = fs.existsSync(target) || fs.lstatSync(target, { throwIfNoEntry: false });
if (existing) {
  const ours = fs.existsSync(path.join(target, '.install.json')) || fs.lstatSync(target).isSymbolicLink();
  if (!ours && !has('force')) {
    console.error(
      `${target} already exists and was not installed by this script.\n` +
        'Move it aside, or pass --force to replace it.'
    );
    process.exit(1);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

fs.mkdirSync(skillsDir, { recursive: true });

const mode = has('link') ? 'link' : 'copy';
if (mode === 'link') {
  fs.symlinkSync(SOURCE, target, 'dir');
} else {
  fs.cpSync(SOURCE, target, { recursive: true });
}

// Written into the real directory, which for a symlink is the repo itself — so
// a linked install keeps the record with the source it points at.
const recordDir = mode === 'link' ? SOURCE : target;
fs.writeFileSync(
  path.join(recordDir, '.install.json'),
  `${JSON.stringify(
    {
      version: pkg.version,
      packageRoot: ROOT,
      entry,
      devRepo: isCheckout ? ROOT : null,
      installedAt: new Date().toISOString(),
      mode,
    },
    null,
    2
  )}\n`
);

if (mode === 'copy') {
  const scripts = path.join(target, 'scripts');
  for (const file of fs.readdirSync(scripts)) {
    if (file.endsWith('.mjs')) fs.chmodSync(path.join(scripts, file), 0o755);
  }
}

const logDir = isCheckout ? path.join(ROOT, '.asc-logs') : path.join(target, '.logs');
process.stdout.write(
  `Installed ${SKILL_NAME} (${mode}) at ${target}\n` +
    `Failures will be recorded in ${logDir}\n` +
    (isCheckout
      ? 'This is a working checkout, so failures hit anywhere on this machine land in the repo.\n'
      : 'No checkout of this package found; failures stay inside the skill directory.\n')
);
