/**
 * The skill is instructions, which means nothing at runtime checks it. A stale
 * tool name or a mistyped enum in SKILL.md does not fail a build, it just makes
 * a model confidently wrong — which is the failure this whole package exists to
 * argue against.
 *
 * So the drift-prone parts are checked here against their sources.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKILL_DIR = path.join(ROOT, 'skills', 'app-store-connect');
const SKILL = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
const SCRIPT = path.join(SKILL_DIR, 'scripts', 'asc-log-failure.mjs');

const references = fs.readdirSync(path.join(SKILL_DIR, 'references')).map((f) => f);
const allText = [SKILL, ...references.map((f) => fs.readFileSync(path.join(SKILL_DIR, 'references', f), 'utf8'))].join(
  '\n'
);

/** Minimal front-matter reader; the repo has no YAML dependency and needs none. */
function frontmatter(md: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) return {};
  const out: Record<string, string> = {};
  let key = '';
  for (const line of m[1]!.split('\n')) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1]!;
      out[key] = kv[2]!.replace(/^>-?\s*$/, '').trim();
    } else if (key) {
      out[key] = `${out[key]} ${line.trim()}`.trim();
    }
  }
  return out;
}

describe('front matter', () => {
  const fm = frontmatter(SKILL);
  const description = fm.description ?? '';

  it('names the skill after its directory', () => {
    expect(fm.name).toBe('app-store-connect');
  });

  it('describes when to use it, not just what it is', () => {
    expect(description).toMatch(/Use whenever/i);
    // The listing truncates at 1,536 characters; a description that runs past
    // that loses the trigger words at the end, which are the useful half.
    expect(description.length).toBeLessThan(1_536);
  });

  // This is the whole permission design: pre-approving the one script here is
  // what stops every recorded failure costing a prompt.
  it('pre-approves the logging script, and nothing else', () => {
    const allowed = fm['allowed-tools'] ?? '';
    expect(allowed).toContain('${CLAUDE_SKILL_DIR}/scripts/asc-log-failure.mjs *');
    expect(allowed).toContain('node ${CLAUDE_SKILL_DIR}/scripts/asc-log-failure.mjs *');
    expect(allowed).not.toMatch(/Write|Edit|Bash\(\*/);
  });
});

describe('what the skill points at exists', () => {
  it.each([...new Set([...SKILL.matchAll(/\$\{CLAUDE_SKILL_DIR\}\/([\w./-]+)/g)].map((m) => m[1]!))])(
    'ships %s',
    (rel) => {
      expect(fs.existsSync(path.join(SKILL_DIR, rel))).toBe(true);
    }
  );

  it('names only tools the server actually registers', () => {
    const registered = new Set([
      ...[...fs.readFileSync(path.join(ROOT, 'src/server.ts'), 'utf8').matchAll(/name: '(asc_[a-z_]+)'/g)].map((m) => m[1]!),
      ...[...fs.readFileSync(path.join(ROOT, 'src/macros/index.ts'), 'utf8').matchAll(/name: '(asc_[a-z_]+)'/g)].map(
        (m) => m[1]!
      ),
    ]);
    const mentioned = new Set([...allText.matchAll(/\b(asc_[a-z_]+)\b/g)].map((m) => m[1]!));
    expect([...mentioned].filter((t) => !registered.has(t))).toEqual([]);
    // And the reverse: a composite tool nobody is told about may as well not exist.
    expect([...registered].filter((t) => !mentioned.has(t))).toEqual([]);
  });

  it('names only resources the server actually serves', () => {
    const served = new Set(
      [...fs.readFileSync(path.join(ROOT, 'src/resources.ts'), 'utf8').matchAll(/uri: '(asc:\/\/[a-z]+)'/g)].map(
        (m) => m[1]!
      )
    );
    const mentioned = new Set([...allText.matchAll(/(asc:\/\/[a-z]+)/g)].map((m) => m[1]!));
    expect([...mentioned].filter((u) => !served.has(u))).toEqual([]);
  });

  it('names only prompts the server actually defines', () => {
    const defined = new Set(
      [...fs.readFileSync(path.join(ROOT, 'src/prompts.ts'), 'utf8').matchAll(/name: '([a-z-]+)',/g)].map((m) => m[1]!)
    );
    const mentioned = new Set([...allText.matchAll(/\/mcp__asc__([a-z-]+)/g)].map((m) => m[1]!));
    expect([...mentioned].filter((p) => !defined.has(p))).toEqual([]);
  });
});

/**
 * The cookbook's own warning: a hand-written enum table is how a widely-copied
 * version of that document came to list an `eventState` value Apple does not
 * have. Any enum-shaped token in the skill has to be real.
 */
describe('nothing derivable is hand-copied', () => {
  it('quotes no enum value that neither Apple’s spec nor the cookbook attests', () => {
    const enums: Record<string, string[]> = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec/enums.json'), 'utf8')).enums;
    const known = new Set(Object.values(enums).flat());

    // The cookbook is the second admissible source, and deliberately so: it
    // records values seen in real responses that Apple's schema never
    // enumerates — error codes like FORBIDDEN_ERROR, asset verdicts like
    // IMAGE_BAD_ASPECT_RATIO, the alpha-3 territory codes. Anything the skill
    // states must trace to one source or the other; inventing a third is how
    // the eventState mistake happened.
    const cookbook = fs.readFileSync(path.join(ROOT, 'docs/COOKBOOK.md'), 'utf8');

    // Prose, HTTP verbs, acronyms and this repo's own vocabulary — none of them
    // claims to be a value Apple returns.
    const notValues = new Set([
      'GET', 'PUT', 'POST', 'PATCH', 'DELETE', 'HTTP', 'HTTPS', 'JSON', 'TSV', 'MD5', 'URL', 'API', 'IAP', 'ASC',
      'UI', 'ISO', 'GO', 'NO', 'READ', 'WRITE', 'RELEASE', 'REVENUE', 'DESTRUCTIVE', 'ACCESS', 'INFRASTRUCTURE',
      'SKILL', 'CLAUDE_SKILL_DIR', 'MCP',
    ]);

    const suspects = [...new Set([...allText.matchAll(/\b([A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)*)\b/g)].map((m) => m[1]!))]
      .filter((t) => !notValues.has(t))
      .filter((t) => !known.has(t))
      .filter((t) => !cookbook.includes(t));

    expect(suspects).toEqual([]);
  });

  it('hardcodes no path from whoever wrote it', () => {
    expect(allText).not.toMatch(/\/Users\/|\/home\/|C:\\\\/);
  });
});

describe('the logging script', () => {
  const run = (args: string[]) =>
    execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
      env: { ...process.env, ASC_FAILURE_LOG: '0' },
    });

  // A script that can fail is a script the model will start avoiding, and then
  // nothing gets recorded at all.
  it.each([
    ['nothing at all', []],
    ['an empty string', ['']],
    ['text that is not JSON', ['just some words']],
    ['a JSON array', ['[1,2,3]']],
    ['a truncated object', ['{"kind":']],
    ['a real payload', ['{"kind":"interpretation","message":"x"}']],
  ])('exits 0 given %s', (_label, args) => {
    expect(() => run(args)).not.toThrow();
  });

  it('says nothing on success, so it never pollutes a transcript', () => {
    expect(run(['{"kind":"interpretation","message":"quiet"}'])).toBe('');
  });
});
