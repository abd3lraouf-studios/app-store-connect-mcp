import { describe, it, expect } from 'vitest';
import { loadIndex, searchOperations, findOperation, describeOperation } from '../src/spec.js';

describe('index', () => {
  it('loads Apple’s full operation set', () => {
    const idx = loadIndex();
    expect(idx.operationCount).toBeGreaterThan(1200);
    expect(idx.apiVersion).toMatch(/^\d+\.\d+/);
    expect(idx.baseUrl).toBe('https://api.appstoreconnect.apple.com');
  });
});

describe('search ranking', () => {
  // Regression: a phrase search treated "subscription price" as one substring
  // and returned zero results, because Apple's identifiers are camelCase.
  // Search is the entry point to every other tool, so this must never recur.
  it('matches a multi-word query term by term', () => {
    const { total, results } = searchOperations({ query: 'subscription price' });
    expect(total).toBeGreaterThan(0);
    expect(results.some((o) => /subscriptionPrice/i.test(o.id))).toBe(true);
  });

  it.each(['beta tester', 'in app purchase', 'app store version', 'game center leaderboard'])(
    'finds results for the natural phrase %j',
    (query) => {
      expect(searchOperations({ query }).total).toBeGreaterThan(0);
    }
  );

  it('requires every term to match, so nonsense returns nothing', () => {
    expect(searchOperations({ query: 'subscription zzzznotathing' }).total).toBe(0);
  });

  it('ranks an exact operationId first', () => {
    const { results } = searchOperations({ query: 'apps_getCollection' });
    expect(results[0]?.id).toBe('apps_getCollection');
  });

  it('prefers a shallow path over a deep relationship path', () => {
    const { results } = searchOperations({ query: 'apps', method: 'GET', limit: 5 });
    expect(results[0]?.path.split('/').length).toBeLessThanOrEqual(3);
  });

  it('filters by method', () => {
    const { results } = searchOperations({ method: 'DELETE', limit: 20 });
    expect(results.every((o) => o.method === 'DELETE')).toBe(true);
  });

  it('filters by risk', () => {
    const { results } = searchOperations({ risk: 'REVENUE', limit: 20 });
    expect(results.every((o) => o.risk === 'REVENUE')).toBe(true);
  });

  it('filters by tag case-insensitively', () => {
    const { results } = searchOperations({ tag: 'apps', limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((o) => o.tags.some((t) => t.toLowerCase() === 'apps'))).toBe(true);
  });

  it('honours the limit and caps it', () => {
    expect(searchOperations({ limit: 3 }).results).toHaveLength(3);
    expect(searchOperations({ limit: 9999 }).results.length).toBeLessThanOrEqual(200);
  });
});

describe('findOperation / describeOperation', () => {
  it('resolves a known operation', () => {
    const op = findOperation('apps_getCollection');
    expect(op?.method).toBe('GET');
    expect(op?.path).toBe('/v1/apps');
    expect(op?.risk).toBe('READ');
  });

  it('returns undefined for an unknown id rather than throwing', () => {
    expect(findOperation('nope_notAnOperation')).toBeUndefined();
  });

  it('describes parameters and resolves the request body schema', () => {
    const described = describeOperation('appPriceSchedules_createInstance') as any;
    expect(described.method).toBe('POST');
    expect(described.risk).toBe('REVENUE');
    expect(described.requestBody?.definition).toBeTruthy();
  });

  it('surfaces path parameters for a templated operation', () => {
    const described = describeOperation('apps_getInstance') as any;
    expect(described.pathParams).toContain('id');
  });

  it('points an unknown id at the search tool', () => {
    expect(() => describeOperation('nope')).toThrow(/asc_search_endpoints/);
  });
});
