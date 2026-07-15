import { performance } from 'node:perf_hooks';
import { BENCHMARK_SUBJECTS } from '../adapters';
import type { PreparedBenchmark } from '../adapters/types';
import { resolveProfile } from '../profiles';
import { SCENARIOS } from '../scenarios/definitions';
import { assertChecksum } from './correctness';
import { summarize } from './statistics';
import type {
  BenchmarkCaseRequest,
  BenchmarkProfile,
  BenchmarkResult,
  BenchmarkSamplingResult
} from './types';

let checksumSink = 0;

export function samplePrepared(
  prepared: PreparedBenchmark,
  profile: BenchmarkProfile,
  now: () => number = () => performance.now(),
  context = 'benchmark'
): BenchmarkSamplingResult {
  prepared.reset();
  assertAndConsume(prepared.validate(), prepared.expectedChecksum, `${context}:pre`);

  for (let index = 0; index < profile.warmupCount; index++) {
    prepared.reset();
    assertAndConsume(prepared.runIteration(), prepared.expectedChecksum, `${context}:warmup:${index}`);
  }

  const samplesMs: number[] = [];
  let checksum = prepared.expectedChecksum;
  for (let index = 0; index < profile.sampleCount; index++) {
    prepared.reset();
    const startedAt = now();
    checksum = prepared.runIteration();
    const duration = now() - startedAt;
    assertAndConsume(checksum, prepared.expectedChecksum, `${context}:sample:${index}`);
    samplesMs.push(duration);
  }

  prepared.reset();
  assertAndConsume(prepared.validate(), prepared.expectedChecksum, `${context}:post`);
  return Object.freeze({
    samplesMs: Object.freeze(samplesMs),
    summary: summarize(samplesMs),
    checksum: Object.freeze({ ...checksum })
  });
}

export function executeCase(request: BenchmarkCaseRequest): BenchmarkResult {
  const workerStartupAndModuleLoadMs = performance.now();
  const scenario = SCENARIOS.find((candidate) => candidate.id === request.scenarioId);
  if (!scenario) throw new Error(`Unknown benchmark scenario "${request.scenarioId}".`);
  const subject = BENCHMARK_SUBJECTS.find((candidate) => candidate.id === request.subjectId);
  if (!subject) throw new Error(`Unknown benchmark subject "${request.subjectId}".`);

  const prepareStartedAt = performance.now();
  const preparation = subject.prepare(scenario, request.input);
  const adapterPreparationMs = performance.now() - prepareStartedAt;
  if (preparation.status === 'unsupported') {
    return Object.freeze({
      status: 'unsupported',
      request,
      subjectVersion: subject.version,
      workerStartupAndModuleLoadMs,
      reason: preparation.reason
    });
  }

  let sampling: BenchmarkSamplingResult;
  let counters: Readonly<Record<string, number>>;
  let teardownMs = 0;
  try {
    sampling = samplePrepared(
      preparation.prepared,
      resolveProfile(request.profile),
      () => performance.now(),
      `${request.scenarioId}/${request.subjectId}/${request.input.caseId}`
    );
    counters = preparation.prepared.counters();
  } finally {
    const teardownStartedAt = performance.now();
    preparation.prepared.dispose();
    teardownMs = performance.now() - teardownStartedAt;
  }
  return Object.freeze({
    status: 'supported',
    request,
    subjectVersion: subject.version,
    workerStartupAndModuleLoadMs,
    adapterPreparationMs,
    preparation: preparation.preparation,
    teardownMs,
    ...sampling,
    counters
  });
}

function assertAndConsume(
  actual: { readonly count: number; readonly value: number },
  expected: { readonly count: number; readonly value: number },
  context: string
): void {
  assertChecksum(actual, expected, context);
  checksumSink = (checksumSink + actual.count + actual.value) % Number.MAX_SAFE_INTEGER;
}
