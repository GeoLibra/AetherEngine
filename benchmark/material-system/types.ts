import type { BenchmarkSummary } from '../harness/types';

export type MaterialBenchmarkProfileName = 'smoke' | 'standard' | 'nightly';
export type MaterialScenarioId =
  | 'parameter-edit-upload-v1'
  | 'pipeline-binding-resolution-v1'
  | 'binding-compatibility-resolution-v1'
  | 'bind-group-cache-resolution-v2'
  | 'pipeline-cache-resolution-v1'
  | 'pipeline-compatibility-resolution-v1'
  | 'standard-lit-construction-v1';

export interface MaterialBenchmarkProfile {
  readonly warmupCount: number;
  readonly sampleCount: number;
  readonly instanceCounts: readonly number[];
}

export interface MaterialBenchmarkEnvironment {
  readonly node: string;
  readonly v8: string;
  readonly platform: string;
  readonly release: string;
  readonly architecture: string;
  readonly cpu: string;
  readonly logicalCpuCount: number;
}

export interface MaterialBenchmarkRepositoryState {
  readonly commit: string;
  readonly dirty: boolean;
}

export interface MaterialScenarioObservation {
  readonly checksum: string;
  readonly semantic: Readonly<Record<string, unknown>>;
  readonly counters: Readonly<Record<string, number>>;
}

export interface MaterialScenarioCase {
  readonly scenarioId: MaterialScenarioId;
  readonly scenarioVersion: 1;
  readonly caseId: string;
  readonly scale: Readonly<Record<string, number>>;
  readonly expected: Readonly<{
    reference: Readonly<Record<string, number>>;
    subject: Readonly<Record<string, number>>;
  }>;
  runReference(): MaterialScenarioObservation;
  runSubject(): MaterialScenarioObservation;
}

export interface MaterialTimingEvidence {
  readonly rawSamplesMs: readonly number[];
  readonly summary: BenchmarkSummary;
}

export interface MaterialBenchmarkResult {
  readonly scenarioId: MaterialScenarioId;
  readonly scenarioVersion: 1;
  readonly caseId: string;
  readonly scale: Readonly<Record<string, number>>;
  readonly reference: MaterialTimingEvidence & MaterialScenarioObservation;
  readonly subject: MaterialTimingEvidence & MaterialScenarioObservation;
  readonly correctness: Readonly<{ status: 'pass'; staleReuse: 0 }>;
}

export interface MaterialBenchmarkReport {
  readonly schemaVersion: 1;
  readonly profile: MaterialBenchmarkProfileName;
  readonly seed: number;
  readonly createdAt: string;
  readonly repository: MaterialBenchmarkRepositoryState;
  readonly environment: MaterialBenchmarkEnvironment;
  readonly runner: Readonly<{
    name: 'material-system';
    warmupCount: number;
    sampleCount: number;
  }>;
  readonly results: readonly MaterialBenchmarkResult[];
}
