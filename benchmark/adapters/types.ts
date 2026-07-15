import type {
  BenchmarkChecksum,
  BenchmarkScenario,
  BenchmarkSubjectId,
  ScenarioInput
} from '../harness/types';

export interface PreparedBenchmark {
  readonly expectedChecksum: BenchmarkChecksum;
  reset(): void;
  validate(): BenchmarkChecksum;
  runIteration(): BenchmarkChecksum;
  counters(): Readonly<Record<string, number>>;
  dispose(): void;
}

export interface PreparationTimings {
  readonly setupMs: number;
  readonly populationMs: number;
  readonly queryPreparationMs: number;
}

export type PrepareResult =
  | {
      readonly status: 'supported';
      readonly prepared: PreparedBenchmark;
      readonly preparation: PreparationTimings;
    }
  | { readonly status: 'unsupported'; readonly reason: string };

export interface BenchmarkSubject {
  readonly id: BenchmarkSubjectId;
  readonly version: string;
  prepare(scenario: BenchmarkScenario, input: ScenarioInput): PrepareResult;
}

export function unsupported(reason: string): PrepareResult {
  return Object.freeze({ status: 'unsupported', reason });
}
