export interface BenchmarkChecksum {
  readonly count: number;
  readonly value: number;
}

export interface BenchmarkSummary {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly median: number;
  readonly p95: number;
  readonly p99: number;
  readonly mad: number;
}

export interface BenchmarkEnvironment {
  readonly node: string;
  readonly v8: string;
  readonly platform: NodeJS.Platform;
  readonly release: string;
  readonly architecture: string;
  readonly cpu: string;
  readonly logicalCpuCount: number;
  readonly totalMemoryBytes: number;
}

export type BenchmarkProfileName = 'smoke' | 'standard' | 'nightly';

export interface BenchmarkProfile {
  readonly name: BenchmarkProfileName;
  readonly warmupCount: number;
  readonly sampleCount: number;
  readonly rounds: number;
}

export type BenchmarkScenarioId =
  | 'dense-read'
  | 'dense-update'
  | 'selective-query'
  | 'query-cache'
  | 'entity-lifecycle'
  | 'component-migration'
  | 'change-filter'
  | 'relations';

export type BenchmarkSubjectId =
  | 'raw-aos'
  | 'raw-soa'
  | 'aether-public'
  | 'aether-iterate-only'
  | 'aether-table-storage'
  | 'aether-write-no-filter'
  | 'aether-full-change'
  | 'bitecs'
  | 'koota';

export interface ScenarioScales {
  readonly smoke: readonly number[];
  readonly standard: readonly number[];
  readonly nightly: readonly number[];
}

export interface BenchmarkScenario {
  readonly id: BenchmarkScenarioId;
  readonly version: number;
  readonly description: string;
  readonly scales: ScenarioScales;
}

export interface ScenarioInput {
  readonly scenarioId: BenchmarkScenarioId;
  readonly scale: number;
  readonly seed: number;
  readonly seedOffset: number;
  readonly fraction: number;
  readonly matchCount: number;
  readonly shape: 'default' | 'deep' | 'wide';
  readonly caseId: string;
}

export interface BenchmarkCaseRequest {
  readonly scenarioId: BenchmarkScenarioId;
  readonly subjectId: BenchmarkSubjectId;
  readonly input: ScenarioInput;
  readonly profile: BenchmarkProfileName;
  readonly round: number;
}

export interface BenchmarkSamplingResult {
  readonly samplesMs: readonly number[];
  readonly summary: BenchmarkSummary;
  readonly checksum: BenchmarkChecksum;
}

export interface SupportedBenchmarkResult extends BenchmarkSamplingResult {
  readonly status: 'supported';
  readonly request: BenchmarkCaseRequest;
  readonly subjectVersion: string;
  readonly adapterPreparationMs: number;
  readonly workerStartupAndModuleLoadMs: number;
  readonly teardownMs: number;
  readonly preparation: {
    readonly setupMs: number;
    readonly populationMs: number;
    readonly queryPreparationMs: number;
  };
  readonly counters: Readonly<Record<string, number>>;
}

export interface UnsupportedBenchmarkResult {
  readonly status: 'unsupported';
  readonly request: BenchmarkCaseRequest;
  readonly subjectVersion: string;
  readonly workerStartupAndModuleLoadMs: number;
  readonly reason: string;
}

export type BenchmarkResult = SupportedBenchmarkResult | UnsupportedBenchmarkResult;

export interface BenchmarkRepositoryState {
  readonly commit: string;
  readonly dirty: boolean;
}

export interface BenchmarkReport {
  readonly schemaVersion: 1;
  readonly profile: BenchmarkProfileName;
  readonly seed: number;
  readonly createdAt: string;
  readonly environment: BenchmarkEnvironment;
  readonly repository: BenchmarkRepositoryState;
  readonly results: readonly BenchmarkResult[];
}
