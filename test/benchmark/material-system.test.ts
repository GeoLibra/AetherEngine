import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { createPipelineKey, resolveMaterialRenderState } from '../../src';
import {
  MATERIAL_BENCHMARK_PROFILES,
  assertMaterialScenarioComparison,
  buildMaterialBenchmarkReport,
  measureMaterialOperation,
  runMaterialBenchmark
} from '../../benchmark/material-system/run';
import {
  PIPELINE_SUBJECT_OPERATIONS,
  createMaterialPipelineCompatibilityCase,
  createMaterialBindingCompatibilityCase,
  createMaterialBindGroupCacheCase,
  createPipelineCacheResolutionCase,
  createStandardLitBuiltinCase,
  createParameterEditUploadCase,
  createPipelineBindingResolutionCase
} from '../../benchmark/material-system/scenarios';
import type {
  MaterialBenchmarkEnvironment,
  MaterialBenchmarkRepositoryState,
  MaterialScenarioCase,
  MaterialScenarioObservation
} from '../../benchmark/material-system/types';

const environment: MaterialBenchmarkEnvironment = Object.freeze({
  node: 'v-test',
  v8: 'v8-test',
  platform: 'test-os',
  release: 'test-release',
  architecture: 'test-arch',
  cpu: 'test-cpu',
  logicalCpuCount: 8
});
const repository: MaterialBenchmarkRepositoryState = Object.freeze({
  commit: '0123456789abcdef',
  dirty: false
});

describe('material benchmark profiles and sampling', () => {
  test('keeps the standard-lit schema and shader ABI structural counters exact', () => {
    const scenario = createStandardLitBuiltinCase(100);
    const reference = scenario.runReference();
    const subject = scenario.runSubject();

    expect(subject.semantic).toEqual(reference.semantic);
    expect(subject.counters).toEqual({
      constructions: 100,
      schemaFields: 3,
      bindingGroups: 4,
      vertexInputs: 2,
      staleReuse: 0
    });
  });

  test('keeps bind-group cache hits and RHI creation counts exact', () => {
    const scenario = createMaterialBindGroupCacheCase({ lookupCount: 1_000, uniqueKeys: 16 });
    const reference = scenario.runReference();
    const subject = scenario.runSubject();

    expect(subject.semantic).toEqual(reference.semantic);
    expect(subject.counters).toMatchObject({
      lookups: 1_000,
      cacheHits: 984,
      cacheMisses: 16,
      rhiBindGroupCreates: 16,
      staleReuse: 0
    });
  });

  test('keeps binding compatibility counts and zero side effects exact', () => {
    for (const instanceCount of [1_000, 10_000]) {
      const scenario = createMaterialBindingCompatibilityCase({ instanceCount });
      const reference = scenario.runReference();
      const subject = scenario.runSubject();

      expect(subject.semantic).toEqual(reference.semantic);
      expect(subject.counters).toMatchObject({
        requests: instanceCount,
        boundItems: instanceCount * 0.9,
        skippedItems: instanceCount * 0.1,
        uniqueBindingKeys: 1,
        synchronousRhiCreates: 0,
        ownershipTransfers: 0
      });
    }
  });

  test('owns one immutable profile map for runner, tests, and artifacts', () => {
    expect(MATERIAL_BENCHMARK_PROFILES).toEqual({
      smoke: { warmupCount: 3, sampleCount: 5, instanceCounts: [100] },
      standard: { warmupCount: 20, sampleCount: 50, instanceCounts: [1_000, 10_000] },
      nightly: { warmupCount: 50, sampleCount: 100, instanceCounts: [10_000, 100_000] }
    });
    expect(Object.isFrozen(MATERIAL_BENCHMARK_PROFILES.standard.instanceCounts)).toBe(true);
  });

  test('excludes warmups, preserves raw samples, and uses independent summary oracles', () => {
    const operation = vi.fn();
    const timestamps = [
      0,
      100,
      100,
      200,
      200,
      300, // three discarded warmups
      300,
      309,
      309,
      310,
      310,
      315,
      315,
      318,
      318,
      320
    ];
    const clock = () => timestamps.shift() ?? Number.NaN;

    const result = measureMaterialOperation('smoke', operation, clock);

    expect(operation).toHaveBeenCalledTimes(8);
    expect(result.rawSamplesMs).toEqual([9, 1, 5, 3, 2]);
    expect(result.summary).toMatchObject({
      count: 5,
      median: 3,
      p95: 9,
      p99: 9,
      max: 9,
      mad: 2
    });
  });

  test.each(['smoke', 'standard', 'nightly'] as const)(
    'emits the exact %s sample count',
    (profile) => {
      let tick = 0;
      const result = measureMaterialOperation(
        profile,
        () => undefined,
        () => tick++
      );

      expect(result.rawSamplesMs).toHaveLength(MATERIAL_BENCHMARK_PROFILES[profile].sampleCount);
      expect(result.rawSamplesMs.every((sample) => sample === 1)).toBe(true);
    }
  );

  test('interleaves reference and subject order while preserving separate samples', () => {
    const calls: string[] = [];
    let lastCall = '';
    let now = 0;
    let clockPhase: 'start' | 'end' = 'start';
    const result = buildMaterialBenchmarkReport(
      'smoke',
      [
        {
          ...staticCase(observation('same')),
          runReference() {
            calls.push('reference');
            lastCall = 'reference';
            return observation('same');
          },
          runSubject() {
            calls.push('subject');
            lastCall = 'subject';
            return observation('same');
          }
        }
      ],
      {
        seed: 1,
        clock() {
          if (clockPhase === 'start') {
            clockPhase = 'end';
            return now;
          }
          clockPhase = 'start';
          now += lastCall === 'reference' ? 1 : 2;
          return now;
        },
        environment,
        repository
      }
    );

    expect(calls).toEqual([
      'reference',
      'subject',
      'subject',
      'reference',
      'reference',
      'subject',
      'subject',
      'reference',
      'reference',
      'subject',
      'subject',
      'reference',
      'reference',
      'subject',
      'subject',
      'reference'
    ]);
    expect(result.results[0]?.reference.rawSamplesMs).toEqual([1, 1, 1, 1, 1]);
    expect(result.results[0]?.subject.rawSamplesMs).toEqual([2, 2, 2, 2, 2]);
    expect(result.results[0]?.reference.summary.median).toBe(1);
    expect(result.results[0]?.subject.summary.median).toBe(2);
  });
});

describe('material benchmark correctness and artifacts', () => {
  test('includes schema, scenario, seed, profile, repository, environment, and raw evidence', () => {
    const scenario = staticCase(observation('same'));
    let tick = 0;

    const report = buildMaterialBenchmarkReport('smoke', [scenario], {
      seed: 0x5eed,
      clock: () => tick++,
      environment,
      repository,
      createdAt: '2026-07-17T00:00:00.000Z'
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      profile: 'smoke',
      seed: 0x5eed,
      environment,
      repository,
      runner: { warmupCount: 3, sampleCount: 5 },
      results: [
        {
          scenarioId: 'parameter-edit-upload-v1',
          scenarioVersion: 1,
          correctness: { status: 'pass', staleReuse: 0 },
          reference: { rawSamplesMs: expect.any(Array) },
          subject: { rawSamplesMs: expect.any(Array) }
        }
      ]
    });
    expect(report.results[0]?.reference.rawSamplesMs).toHaveLength(5);
    expect(report.results[0]?.subject.rawSamplesMs).toHaveLength(5);
  });

  test.each([
    ['reference checksum mismatch', observation('reference'), observation('subject')],
    ['stale reuse', observation('same'), observation('same', { staleReuse: 1 })]
  ] as const)('throws for %s without writing a success artifact', (_label, reference, subject) => {
    const writeArtifact = vi.fn();
    let tick = 0;

    expect(() =>
      runMaterialBenchmark('smoke', {
        cases: [staticCase(reference, subject)],
        seed: 7,
        clock: () => tick++,
        environment,
        repository,
        createdAt: '2026-07-17T00:00:00.000Z',
        writeArtifact
      })
    ).toThrow(/checksum|stale reuse/i);
    expect(writeArtifact).not.toHaveBeenCalled();
  });

  test('validates every warmup and measured observation before artifact publication', () => {
    const writeArtifact = vi.fn();
    let subjectRound = 0;
    let tick = 0;
    const scenario: MaterialScenarioCase = {
      ...staticCase(observation('same')),
      runSubject() {
        subjectRound += 1;
        return observation(subjectRound === 1 ? 'same' : 'later-divergence');
      }
    };

    expect(() =>
      runMaterialBenchmark('smoke', {
        cases: [scenario],
        seed: 9,
        clock: () => tick++,
        environment,
        repository,
        writeArtifact
      })
    ).toThrow(/checksum mismatch/i);
    expect(subjectRound).toBe(2);
    expect(writeArtifact).not.toHaveBeenCalled();
  });
});

describe('versioned material benchmark scenarios', () => {
  test('parameter editing matches full serialization with exact copy and upload gates', () => {
    const scenario = createParameterEditUploadCase({
      fieldCount: 8,
      instanceCount: 100,
      dirtyFraction: 0.1,
      seed: 0x5eed
    });

    const reference = scenario.runReference();
    const subject = scenario.runSubject();
    expect(() => assertMaterialScenarioComparison(scenario, reference, subject)).not.toThrow();
    expect(reference.semantic).toEqual(subject.semantic);
    expect(reference.counters).toMatchObject({
      touchedInstances: 10,
      fullBufferWrites: 10,
      uploadBytes: 320
    });
    expect(subject.counters).toMatchObject({
      touchedInstances: 10,
      uploadBytes: 40,
      blocksCloned: 10,
      valuesSnapshotted: 10,
      parameterBytesCopied: 320
    });
  });

  test('pipeline/binding resolution matches reference and rejects every stale probe', () => {
    const scenario = createPipelineBindingResolutionCase({
      instanceCount: 100,
      contextChurn: 2,
      resourceChurn: 3,
      seed: 0x5eed
    });

    const reference = scenario.runReference();
    const subject = scenario.runSubject();
    expect(() => assertMaterialScenarioComparison(scenario, reference, subject)).not.toThrow();
    expect(reference.semantic).toEqual(subject.semantic);
    expect(subject.counters).toMatchObject({
      candidateScans: 100,
      renderStateResolutions: 100,
      churnRebuilds: 5,
      cacheEntriesCreated: 6,
      cacheMisses: 11,
      staleGenerationMisses: 5,
      policyEntriesRetired: 3,
      policyEntriesDestroyed: 3,
      staleHitRejected: 0,
      staleReuse: 0
    });
    expect(subject.counters.canonicalBytesEncoded).toBeGreaterThan(0);
    expect(subject.semantic).not.toHaveProperty('resolutionRecord');
  });

  test('candidate compatibility reports exact, fallback, skip, and canonical key cardinality', () => {
    const scenario = createMaterialPipelineCompatibilityCase({
      instanceCount: 1_000,
      uniqueMeshLayouts: 16,
      seed: 0x5eed
    });

    const reference = scenario.runReference();
    const subject = scenario.runSubject();

    expect(() => assertMaterialScenarioComparison(scenario, reference, subject)).not.toThrow();
    expect(subject.counters).toMatchObject({
      candidates: 1_000,
      selected: 900,
      fallback: 50,
      skipped: 50,
      uniquePipelineKeys: 32,
      synchronousCompiles: 0,
      staleReuse: 0
    });
  });

  test('pipeline cache resolution preserves Queue outcomes and suppresses duplicate work', () => {
    const scenario = createPipelineCacheResolutionCase({
      itemCount: 1_000,
      uniqueKeys: 16,
      concurrentRequests: 4
    });

    const reference = scenario.runReference();
    const subject = scenario.runSubject();

    expect(() => assertMaterialScenarioComparison(scenario, reference, subject)).not.toThrow();
    expect(subject.counters).toMatchObject({
      queueItems: 1_000,
      uniqueKeys: 16,
      compileRequests: 64,
      duplicateRequests: 48,
      compileStarts: 0,
      synchronousCompiles: 0,
      stalePublish: 0,
      staleReuse: 0
    });
    expect(subject.semantic).toMatchObject({
      readyItems: 250,
      fallbackItems: 250,
      compilingSkips: 0,
      errorSkips: 250,
      staleSkips: 250
    });
  });

  test('keeps the pipeline reference independent from production subject operations', () => {
    const source = readFileSync(
      new URL('../../benchmark/material-system/reference.ts', import.meta.url),
      'utf8'
    );

    expect(source).not.toMatch(
      /\b(?:selectMaterialTechnique|resolveMaterialRenderState|createPipelineKey|createBindingKey)\b/
    );
  });

  test('detects a mutated production pipeline-key subject', () => {
    const scenario = createPipelineBindingResolutionCase(
      {
        instanceCount: 10,
        contextChurn: 1,
        resourceChurn: 1,
        seed: 0x5eed
      },
      {
        ...PIPELINE_SUBJECT_OPERATIONS,
        createPipelineKey(parts) {
          return createPipelineKey({ ...parts, sampleCount: parts.sampleCount + 1 });
        }
      }
    );

    expect(() =>
      assertMaterialScenarioComparison(scenario, scenario.runReference(), scenario.runSubject())
    ).toThrow(/checksum mismatch/i);
  });

  test('detects a mutated production render-state subject', () => {
    const scenario = createPipelineBindingResolutionCase(
      {
        instanceCount: 10,
        contextChurn: 1,
        resourceChurn: 1,
        seed: 0x5eed
      },
      {
        ...PIPELINE_SUBJECT_OPERATIONS,
        resolveRenderState(...args) {
          const resolved = resolveMaterialRenderState(...args);
          return resolved.status === 'conflict'
            ? resolved
            : Object.freeze({ ...resolved, depthWrite: !resolved.depthWrite });
        }
      }
    );

    expect(() =>
      assertMaterialScenarioComparison(scenario, scenario.runReference(), scenario.runSubject())
    ).toThrow(/checksum mismatch/i);
  });
});

function observation(
  checksum: string,
  counters: Readonly<Record<string, number>> = {}
): MaterialScenarioObservation {
  return Object.freeze({
    checksum,
    semantic: Object.freeze({ value: checksum }),
    counters: Object.freeze({
      touchedInstances: 0,
      fullBufferWrites: 0,
      uploadBytes: 0,
      staleReuse: 0,
      ...counters
    })
  });
}

function staticCase(
  reference: MaterialScenarioObservation,
  subject: MaterialScenarioObservation = reference
): MaterialScenarioCase {
  return Object.freeze({
    scenarioId: 'parameter-edit-upload-v1',
    scenarioVersion: 1,
    caseId: 'fixed',
    scale: Object.freeze({ instanceCount: 1 }),
    expected: Object.freeze({ reference: reference.counters, subject: subject.counters }),
    runReference: () => reference,
    runSubject: () => subject
  });
}
