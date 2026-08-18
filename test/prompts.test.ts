import { describe, it, expect } from 'vitest';
import { PROMPTS, renderPrompt } from '../src/prompts.js';

const textOf = (name: string, args: Record<string, string>) =>
  renderPrompt(name, args).messages[0]!.content.text;

/** Templates are wrapped prose, so a phrase can straddle a line break. */
const flat = (name: string, args: Record<string, string>) => textOf(name, args).replace(/\s+/g, ' ');

describe('prompt catalogue', () => {
  it('gives every prompt a description and documents its arguments', () => {
    for (const p of PROMPTS) {
      expect(p.description.length).toBeGreaterThan(20);
      for (const a of p.arguments) expect(a.description.length).toBeGreaterThan(5);
    }
  });

  it('has unique names', () => {
    expect(new Set(PROMPTS.map((p) => p.name)).size).toBe(PROMPTS.length);
  });

  it.each(PROMPTS.map((p) => p.name))('renders %s with its required arguments', (name) => {
    const text = textOf(name, { app: 'com.example.app', days: '30' });
    expect(text).toContain('com.example.app');
    // A prompt only earns its place by chaining calls, so each must name the
    // tools it drives.
    expect(text).toMatch(/asc_call/);
  });

  it('substitutes an optional argument and defaults it when absent', () => {
    expect(textOf('review-triage', { app: 'x', days: '30' })).toContain('30 days');
    expect(textOf('review-triage', { app: 'x' })).toContain('14 days');
  });

  it('refuses an unknown prompt and lists what exists', () => {
    expect(() => renderPrompt('nope', {})).toThrow(/Available: release-readiness/);
  });

  it('refuses a missing required argument', () => {
    expect(() => renderPrompt('pricing-audit', {})).toThrow(/requires the "app" argument/);
  });
});

describe('the traps each workflow encodes', () => {
  it('release-readiness warns about the states that silently block a submission', () => {
    const text = textOf('release-readiness', { app: 'x' });
    expect(text).toMatch(/PROCESSING/);
    expect(text).toMatch(/WAITING_FOR_EXPORT_COMPLIANCE/);
  });

  it('pricing-audit warns that alpha-2 territory codes return an empty list', () => {
    expect(textOf('pricing-audit', { app: 'x' })).toMatch(/alpha-3/);
  });

  it('review-triage warns that sort is rejected and that review text is untrusted', () => {
    const text = textOf('review-triage', { app: 'x' });
    expect(text).toMatch(/Do not pass sort/);
    expect(flat('review-triage', { app: 'x' })).toMatch(/that is the attack/);
  });

  it('the read-only workflows say they change nothing', () => {
    for (const name of ['release-readiness', 'pricing-audit', 'testflight-status']) {
      expect(textOf(name, { app: 'x' })).toMatch(/Change nothing|make none|Read only/);
    }
  });
});
