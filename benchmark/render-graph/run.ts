import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import os from 'node:os';
import { resolve } from 'node:path';
import { summarize } from '../harness/statistics';
import {
  assertRenderGraphScenarioComparison,
  createReferenceRenderGraphScenario,
  createRenderGraphCompilerScenario,
  probeSubmissionSafety,
  type RenderGraphCompilerObservation,
  type RenderGraphCompilerScenario
} from './scenarios';
import type { RenderGraphReferenceResult } from './types';
import { runRenderGraphCoverageEvidence, type RenderGraphCoverageEvidence } from './coverage';

const REFERENCE_SCENARIO_INPUT = Object.freeze({
  seed: 13,
  passCount: 16,
  resourceCount: 32,
  accessDensity: 0.25
});

export type RenderGraphBenchmarkProfileName = 'smoke' | 'standard' | 'nightly';

export interface RenderGraphBenchmarkProfile {
  readonly warmupCount: number;
  readonly sampleCount: number;
  readonly scales: readonly Readonly<{
    passCount: number;
    resourceCount: number;
    accessDensity: number;
  }>[];
}

export const RENDER_GRAPH_BENCHMARK_PROFILES: Readonly<
  Record<RenderGraphBenchmarkProfileName, RenderGraphBenchmarkProfile>
> = Object.freeze({
  smoke: Object.freeze({
    warmupCount: 2,
    sampleCount: 5,
    scales: Object.freeze([
      Object.freeze({ passCount: 16, resourceCount: 32, accessDensity: 0.25 })
    ])
  }),
  standard: Object.freeze({
    warmupCount: 10,
    sampleCount: 30,
    scales: Object.freeze([
      Object.freeze({ passCount: 16, resourceCount: 32, accessDensity: 0.25 }),
      Object.freeze({ passCount: 128, resourceCount: 256, accessDensity: 0.0625 })
    ])
  }),
  nightly: Object.freeze({
    warmupCount: 20,
    sampleCount: 60,
    scales: Object.freeze([
      Object.freeze({ passCount: 1024, resourceCount: 2048, accessDensity: 0.00390625 })
    ])
  })
});

interface RenderGraphTimingEvidence {
  readonly coldSampleMs: number;
  readonly coldObservation: RenderGraphCompilerObservation;
  readonly rawSamplesMs: readonly number[];
  readonly summary: ReturnType<typeof summarize> & { readonly p90: number };
  readonly warmObservation: RenderGraphCompilerObservation;
}

interface RenderGraphBenchmarkResult {
  readonly scenarioId: 'hazard-compile-v1';
  readonly scenarioVersion: 1;
  readonly seed: number;
  readonly scale: Readonly<Record<string, number>>;
  readonly axes: {
    readonly topology: 'seeded-hazard-dag';
    readonly accessPattern: 'whole-buffer';
  };
  readonly reference: RenderGraphTimingEvidence;
  readonly subject: RenderGraphTimingEvidence;
  readonly correctness: { readonly status: 'pass' };
  readonly phases: {
    readonly compile: RenderGraphPhaseTimingEvidence;
    readonly execute: RenderGraphPhaseTimingEvidence;
  };
}

interface RenderGraphPhaseTimingEvidence {
  readonly rawSamplesMs: readonly number[];
  readonly summary: ReturnType<typeof summarize> & { readonly p90: number };
  readonly checksum: string;
  readonly counters: Readonly<Record<string, number>>;
}

export interface RenderGraphBenchmarkReport {
  readonly schemaVersion: 1;
  readonly profile: RenderGraphBenchmarkProfileName;
  readonly seed: number;
  readonly createdAt: string;
  readonly environment: Readonly<Record<string, string | number>>;
  readonly repository: { readonly commit: string; readonly dirty: boolean };
  readonly runner: {
    readonly name: 'render-graph';
    readonly warmupCount: number;
    readonly sampleCount: number;
  };
  readonly submissionSafety: {
    readonly pendingSubmissionAttempts: number;
    readonly prematureReuseCount: number;
    readonly resizeGenerations: number;
    readonly peakRetiringAllocations: number;
    readonly finalTrackedAllocations: number;
    readonly disposedResizeAllocations: number;
  };
  readonly coverage: RenderGraphCoverageEvidence;
  readonly results: readonly RenderGraphBenchmarkResult[];
}

export interface RenderGraphBenchmarkRunOptions {
  readonly seed?: number;
  readonly cases?: readonly RenderGraphCompilerScenario[];
  readonly clock?: () => number;
  readonly createdAt?: string;
  readonly environment?: Readonly<Record<string, string | number>>;
  readonly repository?: { readonly commit: string; readonly dirty: boolean };
  readonly writeArtifact?: (report: RenderGraphBenchmarkReport) => string;
}

export function runRenderGraphReferenceScenario(): RenderGraphReferenceResult {
  return createReferenceRenderGraphScenario(REFERENCE_SCENARIO_INPUT).runReference();
}

export function runRenderGraphBenchmark(
  profileName: RenderGraphBenchmarkProfileName,
  options: RenderGraphBenchmarkRunOptions = {}
): Readonly<{ report: RenderGraphBenchmarkReport; artifactPath: string }> {
  const profile = RENDER_GRAPH_BENCHMARK_PROFILES[profileName];
  const seed = options.seed ?? 0x5eed;
  const cases =
    options.cases ??
    profile.scales.map((scale, index) =>
      createRenderGraphCompilerScenario({ seed: seed + index, ...scale })
    );
  const clock = options.clock ?? performance.now.bind(performance);
  const results = cases.map((scenario) => measureScenario(scenario, profile, clock));
  const report: RenderGraphBenchmarkReport = Object.freeze({
    schemaVersion: 1,
    profile: profileName,
    seed,
    createdAt: options.createdAt ?? new Date().toISOString(),
    environment: options.environment ?? captureEnvironment(),
    repository: options.repository ?? captureRepositoryState(),
    runner: Object.freeze({
      name: 'render-graph' as const,
      warmupCount: profile.warmupCount,
      sampleCount: profile.sampleCount
    }),
    submissionSafety: probeSubmissionSafety(),
    coverage: runRenderGraphCoverageEvidence(),
    results: Object.freeze(results)
  });
  const artifactPath = (options.writeArtifact ?? writeRenderGraphArtifact)(report);
  return Object.freeze({ report, artifactPath });
}

function measureScenario(
  scenario: RenderGraphCompilerScenario,
  profile: RenderGraphBenchmarkProfile,
  clock: () => number
): RenderGraphBenchmarkResult {
  const [coldReference, coldReferenceMs] = time(scenario.runReference, clock);
  const [coldSubject, coldSubjectMs] = time(scenario.runSubject, clock);
  assertRenderGraphScenarioComparison(scenario, coldReference, coldSubject);

  for (let index = 0; index < profile.warmupCount; index += 1) {
    const reference = scenario.runReference();
    const subject = scenario.runSubject();
    assertRenderGraphScenarioComparison(scenario, reference, subject);
  }

  const referenceSamples: number[] = [];
  const subjectSamples: number[] = [];
  let reference = coldReference;
  let subject = coldSubject;
  for (let index = 0; index < profile.sampleCount; index += 1) {
    if (index % 2 === 0) {
      [reference, referenceSamples[index]] = time(scenario.runReference, clock);
      [subject, subjectSamples[index]] = time(scenario.runSubject, clock);
    } else {
      [subject, subjectSamples[index]] = time(scenario.runSubject, clock);
      [reference, referenceSamples[index]] = time(scenario.runReference, clock);
    }
    assertRenderGraphScenarioComparison(scenario, reference, subject);
  }
  return Object.freeze({
    scenarioId: scenario.scenarioId,
    scenarioVersion: scenario.scenarioVersion,
    seed: scenario.workload.options.seed,
    scale: Object.freeze({
      passCount: scenario.workload.options.passCount,
      resourceCount: scenario.workload.options.resourceCount,
      accessDensity: scenario.workload.options.accessDensity,
      accessesPerPass: scenario.workload.accessesPerPass
    }),
    axes: Object.freeze({
      topology: 'seeded-hazard-dag' as const,
      accessPattern: 'whole-buffer' as const
    }),
    reference: timingEvidence(coldReferenceMs, coldReference, referenceSamples, reference),
    subject: timingEvidence(coldSubjectMs, coldSubject, subjectSamples, subject),
    phases: Object.freeze({
      compile: measurePhase(profile, scenario.runSubjectCompilePhase, clock),
      execute: measurePhase(profile, scenario.runSubjectExecutePhase, clock)
    }),
    correctness: Object.freeze({ status: 'pass' as const })
  });
}

function measurePhase(
  profile: RenderGraphBenchmarkProfile,
  operation: RenderGraphCompilerScenario['runSubjectCompilePhase'],
  clock: () => number
): RenderGraphPhaseTimingEvidence {
  for (let index = 0; index < profile.warmupCount; index += 1) operation();
  const samples: number[] = [];
  let observation = operation();
  for (let index = 0; index < profile.sampleCount; index += 1) {
    const start = clock();
    observation = operation();
    const end = clock();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      throw new Error('RenderGraph phase benchmark clock must be finite and monotonic.');
    }
    samples.push(end - start);
  }
  const baseSummary = summarize(samples);
  return Object.freeze({
    rawSamplesMs: Object.freeze(samples),
    summary: Object.freeze({ ...baseSummary, p90: percentile(samples, 0.9) }),
    checksum: observation.checksum,
    counters: observation.counters
  });
}

function time(
  operation: () => RenderGraphCompilerObservation,
  clock: () => number
): [RenderGraphCompilerObservation, number] {
  const start = clock();
  const observation = operation();
  const end = clock();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error('RenderGraph benchmark clock must return finite monotonic timestamps.');
  }
  return [observation, end - start];
}

function timingEvidence(
  coldSampleMs: number,
  coldObservation: RenderGraphCompilerObservation,
  samples: readonly number[],
  warmObservation: RenderGraphCompilerObservation
): RenderGraphTimingEvidence {
  const baseSummary = summarize(samples);
  return Object.freeze({
    coldSampleMs,
    coldObservation,
    rawSamplesMs: Object.freeze([...samples]),
    summary: Object.freeze({ ...baseSummary, p90: percentile(samples, 0.9) }),
    warmObservation
  });
}

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index]!;
}

function writeRenderGraphArtifact(report: RenderGraphBenchmarkReport): string {
  const directory = resolve('benchmark/artifacts/render-graph');
  mkdirSync(directory, { recursive: true });
  const timestamp = report.createdAt.replaceAll(':', '-');
  const path = resolve(directory, `render-graph-${report.profile}-${timestamp}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}

function captureEnvironment(): Readonly<Record<string, string | number>> {
  const processors = cpus();
  return Object.freeze({
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    release: os.release(),
    architecture: process.arch,
    cpu: processors[0]?.model ?? 'unknown',
    logicalCpuCount: processors.length,
    totalMemoryBytes: os.totalmem()
  });
}

function captureRepositoryState(): { readonly commit: string; readonly dirty: boolean } {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '';
  return Object.freeze({ commit, dirty });
}

const cliProfile = process.env.AETHER_RENDER_GRAPH_BENCH_PROFILE;
if (cliProfile !== undefined) {
  if (cliProfile !== 'smoke' && cliProfile !== 'standard' && cliProfile !== 'nightly') {
    throw new Error(`Unknown render-graph benchmark profile: ${cliProfile}.`);
  }
  const result = runRenderGraphBenchmark(cliProfile);
  process.stdout.write(
    `RenderGraph benchmark ${cliProfile}: ${result.report.results.length} cases passed correctness gates.\n`
  );
  process.stdout.write(`Artifact: ${result.artifactPath}\n`);
}
