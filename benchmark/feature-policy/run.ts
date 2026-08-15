import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { summarize } from '../harness/statistics';
import { createFeaturePolicyScenario } from './scenarios';
import type {
  FeaturePolicyBenchmarkProfile,
  FeaturePolicyBenchmarkProfileName,
  FeaturePolicyBenchmarkReport,
  FeaturePolicyObservation,
  FeaturePolicyTiming
} from './types';

export { createFeaturePolicyScenario } from './scenarios';

export const FEATURE_POLICY_BENCHMARK_PROFILES: Readonly<
  Record<FeaturePolicyBenchmarkProfileName, FeaturePolicyBenchmarkProfile>
> = Object.freeze({
  smoke: Object.freeze({ warmupCount: 2, sampleCount: 5, featureCount: 32, candidateCount: 2 }),
  standard: Object.freeze({
    warmupCount: 10,
    sampleCount: 30,
    featureCount: 256,
    candidateCount: 4
  }),
  nightly: Object.freeze({
    warmupCount: 20,
    sampleCount: 60,
    featureCount: 2048,
    candidateCount: 8
  })
});

export function assertFeaturePolicyComparison(
  reference: FeaturePolicyObservation,
  subject: FeaturePolicyObservation
): void {
  if (reference.checksum !== subject.checksum)
    throw new Error(
      `FeaturePolicy benchmark checksum mismatch: ${reference.checksum} !== ${subject.checksum}.`
    );
  if (JSON.stringify(reference.selected) !== JSON.stringify(subject.selected))
    throw new Error('FeaturePolicy benchmark decision oracle mismatch.');
  if (JSON.stringify(reference.evaluations) !== JSON.stringify(subject.evaluations))
    throw new Error('FeaturePolicy benchmark evaluation oracle mismatch.');
  if (subject.counters.hotReadResolveCount !== 0)
    throw new Error('FeaturePolicy hot-read lane must not resolve policy.');
}

export function buildFeaturePolicyBenchmarkReport(
  profileName: FeaturePolicyBenchmarkProfileName,
  options: {
    readonly clock?: () => number;
    readonly createdAt?: string;
    readonly environment?: FeaturePolicyBenchmarkReport['environment'];
    readonly repository?: FeaturePolicyBenchmarkReport['repository'];
  } = {}
): FeaturePolicyBenchmarkReport {
  const profile = FEATURE_POLICY_BENCHMARK_PROFILES[profileName];
  const scenario = createFeaturePolicyScenario(profile.featureCount, profile.candidateCount);
  const clock = options.clock ?? performance.now.bind(performance);
  const referenceSamples: number[] = [];
  const subjectSamples: number[] = [];
  let reference!: FeaturePolicyObservation;
  let subject!: FeaturePolicyObservation;
  for (let round = 0; round < profile.warmupCount + profile.sampleCount; round++) {
    let start = clock();
    reference = scenario.runReference();
    let end = clock();
    assertDuration(start, end);
    if (round >= profile.warmupCount) referenceSamples.push(end - start);
    start = clock();
    subject = scenario.runSubject();
    end = clock();
    assertDuration(start, end);
    assertFeaturePolicyComparison(reference, subject);
    if (round >= profile.warmupCount) subjectSamples.push(end - start);
  }
  return Object.freeze({
    schemaVersion: 1,
    profile: profileName,
    createdAt: options.createdAt ?? new Date().toISOString(),
    environment:
      options.environment ??
      Object.freeze({
        node: process.version,
        platform: process.platform,
        architecture: process.arch
      }),
    repository: options.repository ?? captureRepository(),
    results: Object.freeze([
      Object.freeze({
        featureCount: profile.featureCount,
        candidateCount: profile.candidateCount,
        reference: Object.freeze({ ...reference, ...timing(referenceSamples) }),
        subject: Object.freeze({ ...subject, ...timing(subjectSamples) }),
        correctness: Object.freeze({ status: 'pass' as const, hotReadResolveCount: 0 as const })
      })
    ])
  });
}

export function runFeaturePolicyBenchmark(profile: FeaturePolicyBenchmarkProfileName): string {
  const report = buildFeaturePolicyBenchmarkReport(profile);
  const directory = resolve('benchmark/artifacts/feature-policy');
  mkdirSync(directory, { recursive: true });
  const path = resolve(
    directory,
    `feature-policy-${profile}-${report.createdAt.replaceAll(':', '-')}.json`
  );
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}

function timing(rawSamplesMs: readonly number[]): FeaturePolicyTiming {
  return Object.freeze({
    rawSamplesMs: Object.freeze([...rawSamplesMs]),
    summary: summarize(rawSamplesMs)
  });
}
function assertDuration(start: number, end: number): void {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    throw new Error('FeaturePolicy benchmark clock must be finite and monotonic.');
}
function captureRepository(): FeaturePolicyBenchmarkReport['repository'] {
  return Object.freeze({
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== ''
  });
}

const cliProfile = process.env.AETHER_FEATURE_POLICY_BENCH_PROFILE;
if (cliProfile !== undefined) {
  if (cliProfile !== 'smoke' && cliProfile !== 'standard' && cliProfile !== 'nightly')
    throw new Error(`Unknown FeaturePolicy benchmark profile: ${cliProfile}.`);
  const artifact = runFeaturePolicyBenchmark(cliProfile);
  process.stdout.write(`FeaturePolicy benchmark ${cliProfile} passed.\nArtifact: ${artifact}\n`);
}
