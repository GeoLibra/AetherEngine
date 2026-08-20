import { describe, expect, test, vi } from 'vitest';
import {
  FEATURE_POLICY_BENCHMARK_PROFILES,
  assertFeaturePolicyComparison,
  buildFeaturePolicyBenchmarkReport,
  createFeaturePolicyScenario
} from '../../benchmark/feature-policy/run';

describe('FeaturePolicy benchmark correctness and evidence', () => {
  test('declares the V2 feature and candidate scale axes across profiles', () => {
    expect(FEATURE_POLICY_BENCHMARK_PROFILES).toEqual({
      smoke: { warmupCount: 2, sampleCount: 5, featureCount: 32, candidateCount: 2 },
      standard: { warmupCount: 10, sampleCount: 30, featureCount: 256, candidateCount: 4 },
      nightly: { warmupCount: 20, sampleCount: 60, featureCount: 2048, candidateCount: 8 }
    });
  });

  test('matches an independent decision oracle and keeps hot reads resolve-free', () => {
    const scenario = createFeaturePolicyScenario(32, 2);
    const reference = scenario.runReference();
    const subject = scenario.runSubject();
    assertFeaturePolicyComparison(reference, subject);
    expect(subject.counters.hotReadResolveCount).toBe(0);
    expect(subject.counters.cacheDomainHashes).toBe(1);
    expect(subject.counters.predicateEvaluations).toBe(32);
  });

  test('rejects semantic divergence before publishing a success report', () => {
    const scenario = createFeaturePolicyScenario(32, 2);
    const subject = scenario.runSubject();
    expect(() =>
      assertFeaturePolicyComparison(scenario.runReference(), { ...subject, checksum: 'bad' })
    ).toThrow('checksum mismatch');
    expect(() =>
      assertFeaturePolicyComparison(scenario.runReference(), {
        ...subject,
        evaluations: [`${subject.evaluations[0]}:mutated`, ...subject.evaluations.slice(1)]
      })
    ).toThrow('evaluation oracle mismatch');
  });

  test('retains raw samples, environment metadata, and structural correctness counters', () => {
    let tick = 0;
    const report = buildFeaturePolicyBenchmarkReport('smoke', {
      clock: () => tick++,
      createdAt: '2026-08-15T00:00:00.000Z',
      environment: { node: 'test', platform: 'test', architecture: 'test' },
      repository: { commit: 'abc', dirty: false }
    });
    expect(report.results[0]?.subject.rawSamplesMs).toHaveLength(5);
    expect(report.results[0]?.reference.rawSamplesMs).toHaveLength(5);
    expect(report.results[0]?.subject.counters).toMatchObject({
      hotReadResolveCount: 0,
      selectedFeatures: 32
    });
    expect(report.environment.node).toBe('test');
  });
});
