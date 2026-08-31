import { describe, expect, test } from 'vitest';
import { createRenderGraphWorkload } from '../../benchmark/render-graph/fixtures';
import { runReferenceRenderGraph } from '../../benchmark/render-graph/reference';
import {
  RENDER_GRAPH_BENCHMARK_PROFILES,
  runRenderGraphBenchmark
} from '../../benchmark/render-graph/run';
import {
  assertRenderGraphScenarioComparison,
  createRenderGraphCompilerScenario
} from '../../benchmark/render-graph/scenarios';
import {
  runHistoryDebugReference,
  runHistoryDebugSubject,
  runRenderSystemReference,
  runRenderSystemSubject
} from '../../benchmark/render-graph/integrity-scenarios';

describe('render graph benchmark oracle', () => {
  test('is deterministic for the same versioned seed', () => {
    const input = { seed: 13, passCount: 16, resourceCount: 32, accessDensity: 0.25 } as const;

    expect(runReferenceRenderGraph(createRenderGraphWorkload(input))).toEqual(
      runReferenceRenderGraph(createRenderGraphWorkload(input))
    );
  });

  test('matches the independent oracle for a small exact compiler fixture', () => {
    const scenario = createRenderGraphCompilerScenario({
      seed: 13,
      passCount: 12,
      resourceCount: 8,
      accessDensity: 0.5
    });
    const reference = scenario.runReference();
    const subject = scenario.runSubject();

    expect(() => assertRenderGraphScenarioComparison(scenario, reference, subject)).not.toThrow();
    expect(subject.semantic).toEqual(reference.semantic);
  });

  test('records closed-form work and allocation counters for a larger fixture', () => {
    const scenario = createRenderGraphCompilerScenario({
      seed: 17,
      passCount: 64,
      resourceCount: 32,
      accessDensity: 0.25
    });
    const subject = scenario.runSubject();

    expect(subject.counters).toMatchObject({
      passesVisited: 64,
      accessesExamined: 64 * 8,
      readyOperations: 64 * 2,
      executionSteps: 64 + 2,
      passResolutions: 64
    });
    expect(subject.counters.overlapComparisons).toBeGreaterThan(0);
    expect(subject.counters.adjacencyEntries).toBeGreaterThan(0);
    expect(subject.counters.temporaryIrObjects).toBeGreaterThan(64);
    expect(subject.counters.aliasGroups).toBeGreaterThanOrEqual(0);
    expect(subject.counters.allocations).toBeGreaterThan(0);
    expect(subject.counters.wholeResourceFallbacks).toBe(0);
    expect(subject.semantic.aliasChecksumEquivalent).toBe(true);
    expect(subject.counters.versionCount).toBeGreaterThan(32);
    expect(subject.counters.transitionCount).toBeGreaterThan(0);
    expect(subject.counters.submissionCount).toBe(1);
    expect(subject.counters.commandCount).toBe(64 * 2);
    expect(subject.counters.subresourceKeyCount).toBeGreaterThan(0);
    expect(subject.counters.physicalAllocationCount).toBe(subject.counters.allocations);
  });

  test('executes real history debug and render-system ordering lanes across scale axes', () => {
    for (const scale of [4, 16, 64]) {
      const history = runHistoryDebugSubject(scale);
      const renderSystems = runRenderSystemSubject(scale);

      expect(history).toEqual(runHistoryDebugReference(scale));
      expect(history.counters).toEqual({
        historyResources: scale,
        versionSlots: scale * 2,
        boundVersionSlots: scale,
        pendingSubmissionReferences: scale,
        policyHistoriesInvalidated: Math.ceil(scale / 2),
        policyHistoriesPreserved: Math.floor(scale / 2),
        scheduledSteps: scale + 2
      });
      expect(renderSystems).toEqual(runRenderSystemReference(scale));
      expect(renderSystems.counters).toEqual({
        instances: scale,
        semanticEdges: scale - 1,
        scheduleSteps: scale + 2,
        internalNodes: 2
      });
      expect(history.checksum).toMatch(/^[0-9a-f]{8}$/);
      expect(renderSystems.checksum).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  test('publishes schema-versioned smoke evidence with raw cold and warm samples', () => {
    const scenario = createRenderGraphCompilerScenario({
      seed: 23,
      passCount: 8,
      resourceCount: 8,
      accessDensity: 0.5
    });
    let clock = 0;
    const result = runRenderGraphBenchmark('smoke', {
      cases: [scenario],
      clock: () => ++clock,
      createdAt: '2026-07-18T00:00:00.000Z',
      environment: { node: 'test', platform: 'test', architecture: 'test', cpu: 'test' },
      repository: { commit: 'abc', dirty: false },
      writeArtifact: () => '/tmp/render-graph-smoke.json'
    });

    expect(result.artifactPath).toBe('/tmp/render-graph-smoke.json');
    expect(result.report).toMatchObject({ schemaVersion: 1, profile: 'smoke' });
    expect(result.report.submissionSafety).toEqual({
      pendingSubmissionAttempts: 1,
      prematureReuseCount: 0,
      resizeGenerations: 64,
      peakRetiringAllocations: 0,
      finalTrackedAllocations: 0,
      disposedResizeAllocations: 64
    });
    expect(result.report.results[0]).toMatchObject({
      seed: 23,
      axes: { topology: 'seeded-hazard-dag', accessPattern: 'whole-buffer' }
    });
    expect(result.report.results[0]?.reference.rawSamplesMs).toHaveLength(
      RENDER_GRAPH_BENCHMARK_PROFILES.smoke.sampleCount
    );
    expect(result.report.results[0]?.subject.rawSamplesMs).toHaveLength(
      RENDER_GRAPH_BENCHMARK_PROFILES.smoke.sampleCount
    );
    expect(result.report.results[0]?.reference.coldSampleMs).toBe(1);
    expect(result.report.results[0]?.subject.coldSampleMs).toBe(1);
    expect(result.report.results[0]?.subject.coldObservation).toBeDefined();
    expect(result.report.results[0]?.subject.warmObservation).toBeDefined();
    expect(result.report.results[0]?.subject.summary.p90).toBe(1);
    expect(result.report.results[0]?.phases.compile.rawSamplesMs).toHaveLength(
      RENDER_GRAPH_BENCHMARK_PROFILES.smoke.sampleCount
    );
    expect(result.report.results[0]?.phases.execute.counters).toMatchObject({
      submissions: 1,
      commands: 16
    });
    expect(result.report.coverage.scaleAxes).toEqual({
      passCounts: [16, 128, 1024],
      resourceCounts: [32, 256, 2048]
    });
    expect(result.report.coverage.workloadFamilies.map((family) => family.id)).toEqual([
      'whole-resource',
      'buffer-range',
      'texture-subresource',
      'linear-chain',
      'fan-out-fan-in',
      'culled-branch',
      'aliasable-lifetimes'
    ]);
    expect(result.report.coverage.largeScale).toMatchObject({
      passCount: 1024,
      resourceCount: 2048,
      accessesExamined: 1024,
      status: 'pass'
    });
  });
});
