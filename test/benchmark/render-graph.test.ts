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
    expect(result.report.results[0]?.reference.rawSamplesMs).toHaveLength(
      RENDER_GRAPH_BENCHMARK_PROFILES.smoke.sampleCount
    );
    expect(result.report.results[0]?.subject.rawSamplesMs).toHaveLength(
      RENDER_GRAPH_BENCHMARK_PROFILES.smoke.sampleCount
    );
    expect(result.report.results[0]?.reference.coldSampleMs).toBe(1);
    expect(result.report.results[0]?.subject.coldSampleMs).toBe(1);
  });
});
