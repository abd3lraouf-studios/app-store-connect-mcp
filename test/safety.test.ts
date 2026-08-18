/**
 * The gate is the only thing standing between a model and a live pricing
 * change, so it gets the most thorough coverage in the suite.
 */
import { describe, it, expect } from 'vitest';
import { SafetyGate, isWrite, type Risk } from '../src/safety.js';

const REQ = {
  operationId: 'appPriceSchedules_createInstance',
  method: 'POST',
  path: '/v1/appPriceSchedules',
  query: { a: 1 },
  body: { data: { type: 'appPriceSchedules' } },
};

const ALL_RISKS: Risk[] = [
  'READ',
  'WRITE',
  'RELEASE',
  'REVENUE',
  'INFRASTRUCTURE',
  'ACCESS',
  'DESTRUCTIVE',
];

describe('isWrite', () => {
  it('treats only READ as a non-write', () => {
    expect(isWrite('READ')).toBe(false);
    for (const r of ALL_RISKS.filter((r) => r !== 'READ')) expect(isWrite(r)).toBe(true);
  });
});

describe('default mode', () => {
  it('lets reads straight through', () => {
    expect(new SafetyGate('default').check(REQ, 'READ')).toBeNull();
  });

  it('lets a plain WRITE through without confirmation', () => {
    expect(new SafetyGate('default').check(REQ, 'WRITE')).toBeNull();
  });

  it.each(['REVENUE', 'DESTRUCTIVE', 'INFRASTRUCTURE', 'ACCESS', 'RELEASE'] as Risk[])(
    'gates %s and issues a token',
    (risk) => {
      const blocked = new SafetyGate('default').check(REQ, risk);
      expect(blocked?.blocked).toBe(true);
      expect(blocked?.token).toBeTruthy();
      expect(blocked?.reason).toContain(risk);
    }
  );
});

describe('read-only mode', () => {
  it('permits reads', () => {
    expect(new SafetyGate('read-only').check(REQ, 'READ')).toBeNull();
  });

  it('blocks every write with no token to escape through', () => {
    for (const risk of ALL_RISKS.filter((r) => r !== 'READ')) {
      const blocked = new SafetyGate('read-only').check(REQ, risk);
      expect(blocked?.blocked).toBe(true);
      expect(blocked?.token).toBeUndefined();
      expect(blocked?.reason).toMatch(/read-only/);
    }
  });
});

describe('confirm and no-confirm modes', () => {
  it('confirm mode gates even a plain WRITE', () => {
    expect(new SafetyGate('confirm').check(REQ, 'WRITE')?.token).toBeTruthy();
  });

  it('no-confirm mode lets a DESTRUCTIVE write through', () => {
    expect(new SafetyGate('no-confirm').check(REQ, 'DESTRUCTIVE')).toBeNull();
  });
});

describe('token handshake', () => {
  it('accepts the issued token for the identical request', () => {
    const gate = new SafetyGate('default');
    const token = gate.check(REQ, 'REVENUE')?.token as string;
    expect(gate.check(REQ, 'REVENUE', token)).toBeNull();
  });

  it('is single use', () => {
    const gate = new SafetyGate('default');
    const token = gate.check(REQ, 'REVENUE')?.token as string;
    expect(gate.check(REQ, 'REVENUE', token)).toBeNull();
    const second = gate.check(REQ, 'REVENUE', token);
    expect(second?.blocked).toBe(true);
    expect(second?.reason).toMatch(/unknown or already used/);
  });

  it('rejects a token that was never issued', () => {
    const gate = new SafetyGate('default');
    gate.check(REQ, 'REVENUE');
    expect(gate.check(REQ, 'REVENUE', 'forged')?.reason).toMatch(/unknown or already used/);
  });

  // The binding is the whole point: a token obtained for something harmless
  // must not authorise something expensive.
  it.each([
    ['operationId', { ...REQ, operationId: 'apps_deleteInstance' }],
    ['path', { ...REQ, path: '/v1/somethingElse' }],
    ['query', { ...REQ, query: { a: 2 } }],
    ['body', { ...REQ, body: { data: { type: 'other' } } }],
  ])('refuses a token issued for a request with a different %s', (_field, mutated) => {
    const gate = new SafetyGate('default');
    const token = gate.check(REQ, 'REVENUE')?.token as string;
    const result = gate.check(mutated, 'REVENUE', token);
    expect(result?.blocked).toBe(true);
    expect(result?.reason).toMatch(/does not match/);
  });
});

describe('mode description', () => {
  it('names each mode so asc_status can report it', () => {
    expect(new SafetyGate('read-only').describeMode).toMatch(/read-only/);
    expect(new SafetyGate('no-confirm').describeMode).toMatch(/immediately/);
    expect(new SafetyGate('default').describeMode).toMatch(/REVENUE/);
  });
});
