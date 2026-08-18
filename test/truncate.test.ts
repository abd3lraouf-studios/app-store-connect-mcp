import { describe, it, expect } from 'vitest';
import { fitToBudget } from '../src/truncate.js';

const row = (i: number) => ({ id: String(i), type: 'apps', attributes: { name: `App ${i}`, note: 'x'.repeat(200) } });

describe('fitToBudget', () => {
  it('leaves a small payload alone', () => {
    const out = fitToBudget({ data: [row(1)] }, 40_000);
    expect(out.truncated).toBe(false);
    expect(out.overflow).toBeUndefined();
    expect(JSON.parse(out.text).data).toHaveLength(1);
  });

  // Cutting the serialised string would hand the model invalid JSON; dropping
  // whole items keeps it parseable.
  it('drops items rather than cutting the JSON, and stays parseable', () => {
    const out = fitToBudget({ data: Array.from({ length: 500 }, (_, i) => row(i)) }, 5_000);
    expect(out.truncated).toBe(true);
    const parsed = JSON.parse(out.text);
    expect(parsed.data.length).toBeGreaterThan(0);
    expect(parsed.data.length).toBeLessThan(500);
    expect(out.text.length).toBeLessThanOrEqual(5_000);
  });

  it('states how much it kept, and how to narrow the request', () => {
    const parsed = JSON.parse(fitToBudget({ data: Array.from({ length: 500 }, (_, i) => row(i)) }, 5_000).text);
    expect(parsed.truncated.total).toBe(500);
    expect(parsed.truncated.shown).toBe(parsed.data.length);
    expect(parsed.truncated.whatToDo).toMatch(/fields\[/);
  });

  it('keeps the full text so it can be served as a resource', () => {
    const out = fitToBudget({ data: Array.from({ length: 500 }, (_, i) => row(i)) }, 5_000);
    expect(JSON.parse(out.overflow as string).data).toHaveLength(500);
  });

  it('handles the paginated wrapper shape too', () => {
    const out = fitToBudget({ count: 300, pages: 3, items: Array.from({ length: 300 }, (_, i) => row(i)) }, 5_000);
    expect(JSON.parse(out.text).items.length).toBeLessThan(300);
  });

  it('reports rather than emitting broken JSON when there is no list to trim', () => {
    const out = fitToBudget({ blob: 'y'.repeat(50_000) }, 5_000);
    expect(out.truncated).toBe(true);
    const parsed = JSON.parse(out.text);
    expect(parsed.whatToDo).toMatch(/fullResult/);
    expect(out.overflow).toBeTruthy();
  });
});

describe('analytics-shaped results', () => {
  // Analytics returns `rows`, not `data` or `items`. Without that, a large
  // report degraded to "not a list that can be shortened" and lost everything.
  it('trims rows rather than giving up on the whole result', () => {
    const out = fitToBudget(
      {
        columns: ['Date', 'N'],
        rowCount: 2000,
        rows: Array.from({ length: 2000 }, (_, i) => ({ Date: '2026-08-01', N: String(i), pad: 'y'.repeat(80) })),
      },
      6_000
    );
    expect(out.truncated).toBe(true);
    const parsed = JSON.parse(out.text);
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(parsed.rows.length).toBeLessThan(2000);
    expect(parsed.columns).toEqual(['Date', 'N']);
  });
});
