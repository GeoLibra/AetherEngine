import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import os from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { summarize } from '../harness/statistics';
import { createMaterialScenarioCases } from './scenarios';
import type {
  MaterialBenchmarkEnvironment,
  MaterialBenchmarkProfile,
  MaterialBenchmarkProfileName,
  MaterialBenchmarkReport,
  MaterialBenchmarkRepositoryState,
  MaterialScenarioCase,
  MaterialScenarioObservation,
  MaterialTimingEvidence
} from './types';

export const MATERIAL_BENCHMARK_PROFILES: Readonly<
  Record<MaterialBenchmarkProfileName, MaterialBenchmarkProfile>
> = Object.freeze({
  smoke: Object.freeze({
    warmupCount: 3,
    sampleCount: 5,
    instanceCounts: Object.freeze([100])
  }),
  standard: Object.freeze({
    warmupCount: 20,
    sampleCount: 50,
    instanceCounts: Object.freeze([1_000, 10_000])
  }),
  nightly: Object.freeze({
    warmupCount: 50,
    sampleCount: 100,
    instanceCounts: Object.freeze([10_000, 100_000])
  })
});

export interface MaterialBenchmarkBuildOptions {
  readonly seed: number;
  readonly clock?: () => number;
  readonly environment?: MaterialBenchmarkEnvironment;
  readonly repository?: MaterialBenchmarkRepositoryState;
  readonly createdAt?: string;
}

export interface MaterialBenchmarkRunOptions extends Partial<MaterialBenchmarkBuildOptions> {
  readonly cases?: readonly MaterialScenarioCase[];
  readonly writeArtifact?: (report: MaterialBenchmarkReport) => string;
}

export function measureMaterialOperation(
  profileName: MaterialBenchmarkProfileName,
  operation: () => unknown,
  clock: () => number = performance.now.bind(performance)
): MaterialTimingEvidence {
  const profile = MATERIAL_BENCHMARK_PROFILES[profileName];
  for (let index = 0; index < profile.warmupCount; index += 1) {
    const start = clock();
    operation();
    const end = clock();
    assertDuration(start, end);
  }
  const rawSamplesMs: number[] = [];
  for (let index = 0; index < profile.sampleCount; index += 1) {
    const start = clock();
    operation();
    const end = clock();
    assertDuration(start, end);
    rawSamplesMs.push(end - start);
  }
  return Object.freeze({
    rawSamplesMs: Object.freeze(rawSamplesMs),
    summary: summarize(rawSamplesMs)
  });
}

export function assertMaterialScenarioComparison(
  scenario: MaterialScenarioCase,
  reference: MaterialScenarioObservation,
  subject: MaterialScenarioObservation
): void {
  if (reference.checksum !== subject.checksum) {
    throw new Error(
      `Material benchmark checksum mismatch for ${scenario.caseId}: ${reference.checksum} !== ${subject.checksum}.`
    );
  }
  if (JSON.stringify(reference.semantic) !== JSON.stringify(subject.semantic)) {
    throw new Error(`Material benchmark semantic oracle mismatch for ${scenario.caseId}.`);
  }
  if ((subject.counters.staleReuse ?? 0) !== 0) {
    throw new Error(`Material benchmark stale reuse must remain zero for ${scenario.caseId}.`);
  }
  assertExpectedCounters('reference', scenario, reference.counters, scenario.expected.reference);
  assertExpectedCounters('subject', scenario, subject.counters, scenario.expected.subject);

  if (scenario.scenarioId === 'parameter-edit-upload-v1') {
    if (reference.counters.fullBufferWrites !== reference.counters.touchedInstances) {
      throw new Error('Parameter reference must fully write every touched instance.');
    }
    if ((subject.counters.uploadBytes ?? Infinity) > (reference.counters.uploadBytes ?? -1)) {
      throw new Error('Material subject upload bytes exceed full-buffer reference bytes.');
    }
  }
}

export function buildMaterialBenchmarkReport(
  profileName: MaterialBenchmarkProfileName,
  cases: readonly MaterialScenarioCase[],
  options: MaterialBenchmarkBuildOptions
): MaterialBenchmarkReport {
  const profile = MATERIAL_BENCHMARK_PROFILES[profileName];
  const clock = options.clock ?? performance.now.bind(performance);
  const results = cases.map((scenario) => {
    const measured = measureMaterialScenario(profileName, scenario, clock);
    return Object.freeze({
      scenarioId: scenario.scenarioId,
      scenarioVersion: scenario.scenarioVersion,
      caseId: scenario.caseId,
      scale: scenario.scale,
      reference: Object.freeze({ ...measured.reference, ...measured.referenceTiming }),
      subject: Object.freeze({ ...measured.subject, ...measured.subjectTiming }),
      correctness: Object.freeze({ status: 'pass' as const, staleReuse: 0 as const })
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    profile: profileName,
    seed: options.seed,
    createdAt: options.createdAt ?? new Date().toISOString(),
    repository: options.repository ?? captureRepositoryState(),
    environment: options.environment ?? captureEnvironment(),
    runner: Object.freeze({
      name: 'material-system' as const,
      warmupCount: profile.warmupCount,
      sampleCount: profile.sampleCount
    }),
    results: Object.freeze(results)
  });
}

function measureMaterialScenario(
  profileName: MaterialBenchmarkProfileName,
  scenario: MaterialScenarioCase,
  clock: () => number
): Readonly<{
  reference: MaterialScenarioObservation;
  subject: MaterialScenarioObservation;
  referenceTiming: MaterialTimingEvidence;
  subjectTiming: MaterialTimingEvidence;
}> {
  const profile = MATERIAL_BENCHMARK_PROFILES[profileName];
  const referenceSamples: number[] = [];
  const subjectSamples: number[] = [];
  let reference: MaterialScenarioObservation | undefined;
  let subject: MaterialScenarioObservation | undefined;
  const rounds = profile.warmupCount + profile.sampleCount;

  for (let round = 0; round < rounds; round += 1) {
    let referenceDuration: number;
    let subjectDuration: number;
    if (round % 2 === 0) {
      [reference, referenceDuration] = timeObservation(scenario.runReference, clock);
      [subject, subjectDuration] = timeObservation(scenario.runSubject, clock);
    } else {
      [subject, subjectDuration] = timeObservation(scenario.runSubject, clock);
      [reference, referenceDuration] = timeObservation(scenario.runReference, clock);
    }
    assertMaterialScenarioComparison(scenario, reference, subject);
    if (round >= profile.warmupCount) {
      referenceSamples.push(referenceDuration);
      subjectSamples.push(subjectDuration);
    }
  }

  if (reference === undefined || subject === undefined) {
    throw new Error('Material benchmark profile must contain at least one sampling round.');
  }
  return Object.freeze({
    reference,
    subject,
    referenceTiming: timingEvidence(referenceSamples),
    subjectTiming: timingEvidence(subjectSamples)
  });
}

function timeObservation(
  operation: () => MaterialScenarioObservation,
  clock: () => number
): readonly [MaterialScenarioObservation, number] {
  const start = clock();
  const observation = operation();
  const end = clock();
  assertDuration(start, end);
  return Object.freeze([observation, end - start]);
}

function timingEvidence(samples: readonly number[]): MaterialTimingEvidence {
  return Object.freeze({
    rawSamplesMs: Object.freeze([...samples]),
    summary: summarize(samples)
  });
}

export function runMaterialBenchmark(
  profileName: MaterialBenchmarkProfileName,
  options: MaterialBenchmarkRunOptions = {}
): Readonly<{ report: MaterialBenchmarkReport; artifactPath: string }> {
  const seed = options.seed ?? 0x5eed;
  const profile = MATERIAL_BENCHMARK_PROFILES[profileName];
  const cases =
    options.cases ?? createMaterialScenarioCases(profileName, profile.instanceCounts, seed);
  const report = buildMaterialBenchmarkReport(profileName, cases, {
    seed,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.repository === undefined ? {} : { repository: options.repository }),
    ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt })
  });
  const artifactPath = (options.writeArtifact ?? writeMaterialArtifact)(report);
  return Object.freeze({ report, artifactPath });
}

export function writeMaterialArtifact(report: MaterialBenchmarkReport): string {
  const directory = resolve('benchmark/artifacts/material-system');
  mkdirSync(directory, { recursive: true });
  const timestamp = report.createdAt.replaceAll(':', '-');
  const path = resolve(directory, `material-system-${report.profile}-${timestamp}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}

function captureEnvironment(): MaterialBenchmarkEnvironment {
  const processors = cpus();
  return Object.freeze({
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    release: os.release(),
    architecture: process.arch,
    cpu: processors[0]?.model ?? 'unknown',
    logicalCpuCount: processors.length
  });
}

function captureRepositoryState(): MaterialBenchmarkRepositoryState {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '';
  return Object.freeze({ commit, dirty });
}

function assertExpectedCounters(
  subjectName: string,
  scenario: MaterialScenarioCase,
  actual: Readonly<Record<string, number>>,
  expected: Readonly<Record<string, number>>
): void {
  for (const [counter, value] of Object.entries(expected)) {
    if (actual[counter] !== value) {
      throw new Error(
        `${scenario.caseId} ${subjectName} counter ${counter} expected ${value}, received ${actual[counter] ?? '<missing>'}.`
      );
    }
  }
}

function assertDuration(start: number, end: number): void {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error('Material benchmark clock must return finite monotonic timestamps.');
  }
}

const cliProfile = process.env.AETHER_MATERIAL_BENCH_PROFILE;
if (cliProfile !== undefined) {
  if (cliProfile !== 'smoke' && cliProfile !== 'standard' && cliProfile !== 'nightly') {
    throw new Error(`Unknown material-system benchmark profile: ${cliProfile}.`);
  }
  const result = runMaterialBenchmark(cliProfile);
  process.stdout.write(
    `Material benchmark ${cliProfile}: ${result.report.results.length} cases passed correctness gates.\n`
  );
  process.stdout.write(`Artifact: ${result.artifactPath}\n`);
}
