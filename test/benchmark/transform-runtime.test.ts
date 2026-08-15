import { describe, expect, test } from 'vitest';
import { assertTransformBenchmarkSamples } from '../../benchmark/transform-runtime-runner-guard.mjs';
import {
  createTransformExtractWorkload,
  runTransformExtractSubject
} from '../../benchmark/transform-runtime-scenario';

describe('transform-runtime benchmark runner guard', () => {
  test('rejects a zero-sample benchmark report even when Vitest exits successfully', () => {
    expect(() =>
      assertTransformBenchmarkSamples({
        files: [{ groups: [{ benchmarks: [{ name: 'extract', samples: [], sampleCount: 0 }] }] }]
      })
    ).toThrow(/zero finite samples/i);
  });

  test('rejects non-finite samples and accepts every finite populated lane', () => {
    expect(() =>
      assertTransformBenchmarkSamples({
        files: [
          {
            groups: [
              {
                benchmarks: [{ name: 'extract', samples: [Number.NaN], sampleCount: 1 }]
              }
            ]
          }
        ]
      })
    ).toThrow(/finite/i);
    expect(() =>
      assertTransformBenchmarkSamples({
        files: [
          {
            groups: [
              {
                benchmarks: [
                  { name: '100', samples: [0.1, 0.2], sampleCount: 2 },
                  { name: '1000', samples: [1.5], sampleCount: 1 },
                  { name: '10000', samples: [8], sampleCount: 1 }
                ]
              }
            ]
          }
        ]
      })
    ).not.toThrow();
  });
});

describe('transform-runtime benchmark oracle', () => {
  test('uses the independent half-alpha translation oracle before timing lanes', () => {
    const workload = createTransformExtractWorkload(100);

    expect(runTransformExtractSubject(workload)).toEqual({
      count: 100,
      checksum: 718.75
    });
  });
});
