import type { BenchmarkSummary } from '../harness/types';

export type FeaturePolicyBenchmarkProfileName = 'smoke' | 'standard' | 'nightly';
export interface FeaturePolicyBenchmarkProfile {
  readonly warmupCount: number;
  readonly sampleCount: number;
  readonly featureCount: number;
  readonly candidateCount: number;
}
export interface FeaturePolicyObservation {
  readonly checksum: string;
  readonly selected: readonly string[];
  readonly evaluations: readonly string[];
  readonly counters: Readonly<Record<string, number>>;
}
export interface FeaturePolicyScenario {
  readonly featureCount: number;
  readonly candidateCount: number;
  runReference(): FeaturePolicyObservation;
  runSubject(): FeaturePolicyObservation;
}
export interface FeaturePolicyTiming {
  readonly rawSamplesMs: readonly number[];
  readonly summary: BenchmarkSummary;
}
export interface FeaturePolicyBenchmarkResult {
  readonly featureCount: number;
  readonly candidateCount: number;
  readonly reference: FeaturePolicyObservation & FeaturePolicyTiming;
  readonly subject: FeaturePolicyObservation & FeaturePolicyTiming;
  readonly correctness: Readonly<{ status: 'pass'; hotReadResolveCount: 0 }>;
}
export interface FeaturePolicyBenchmarkReport {
  readonly schemaVersion: 1;
  readonly profile: FeaturePolicyBenchmarkProfileName;
  readonly createdAt: string;
  readonly environment: Readonly<{ node: string; platform: string; architecture: string }>;
  readonly repository: Readonly<{ commit: string; dirty: boolean }>;
  readonly results: readonly FeaturePolicyBenchmarkResult[];
}
