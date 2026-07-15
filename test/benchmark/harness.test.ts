import { describe, expect, test } from 'vitest';
import { assertChecksum } from '../../benchmark/harness/correctness';
import { captureEnvironment } from '../../benchmark/harness/environment';
import { deterministicOrder } from '../../benchmark/harness/ordering';
import { summarize } from '../../benchmark/harness/statistics';
import { resolveProfile } from '../../benchmark/profiles';

describe('benchmark statistics', () => {
  test('summarizes samples without mutating caller order', () => {
    const samples = [20, 1, 10, 11, 2, 19, 3, 18, 4, 17, 5, 16, 6, 15, 7, 14, 8, 13, 9, 12];

    const summary = summarize(samples);

    expect(summary).toEqual({
      count: 20,
      min: 1,
      max: 20,
      mean: 10.5,
      median: 10.5,
      p95: 19,
      p99: 20,
      mad: 5
    });
    expect(samples[0]).toBe(20);
  });

  test('rejects empty and non-finite samples', () => {
    expect(() => summarize([])).toThrow('at least one');
    expect(() => summarize([1, Number.NaN])).toThrow('finite');
  });
});

describe('benchmark correctness', () => {
  test('accepts equivalent checksums and reports mismatches with context', () => {
    expect(() =>
      assertChecksum({ count: 2, value: 3.0000001 }, { count: 2, value: 3 }, 'dense-read')
    ).not.toThrow();
    expect(() =>
      assertChecksum({ count: 1, value: 3 }, { count: 2, value: 3 }, 'dense-read')
    ).toThrow('dense-read');
  });
});

describe('benchmark profiles and ordering', () => {
  test('resolves immutable profiles and rejects unknown names', () => {
    expect(resolveProfile('smoke')).toMatchObject({ sampleCount: 3, warmupCount: 1, rounds: 1 });
    expect(resolveProfile('standard').sampleCount).toBeGreaterThanOrEqual(30);
    expect(Object.isFrozen(resolveProfile('nightly'))).toBe(true);
    expect(() => resolveProfile('fast')).toThrow('Unknown benchmark profile');
  });

  test('creates a deterministic permutation without mutating input', () => {
    const cases = ['a', 'b', 'c', 'd', 'e'];
    const first = deterministicOrder(cases, 42);
    const second = deterministicOrder(cases, 42);

    expect(first).toEqual(second);
    expect(first).not.toEqual(cases);
    expect([...first].sort()).toEqual(cases);
    expect(cases).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('benchmark environment', () => {
  test('captures frozen runtime and machine metadata', () => {
    const environment = captureEnvironment();

    expect(environment.node).toBe(process.version);
    expect(environment.v8.length).toBeGreaterThan(0);
    expect(environment.cpu.length).toBeGreaterThan(0);
    expect(environment.totalMemoryBytes).toBeGreaterThan(0);
    expect(Object.isFrozen(environment)).toBe(true);
  });
});
