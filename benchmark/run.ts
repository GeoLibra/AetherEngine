import { resolve } from 'node:path';
import { BENCHMARK_SUBJECTS } from './adapters';
import { runChildCase } from './harness/child-process';
import { captureEnvironment, captureRepositoryState } from './harness/environment';
import { deterministicOrder } from './harness/ordering';
import { printReport, writeArtifact } from './harness/reporter';
import type {
  BenchmarkCaseRequest,
  BenchmarkProfileName,
  BenchmarkReport,
  BenchmarkScenarioId,
  BenchmarkSubjectId
} from './harness/types';
import { resolveProfile } from './profiles';
import { SCENARIOS, createScenarioInputs } from './scenarios/definitions';

const DENSE_UPDATE_DIAGNOSTICS = new Set<BenchmarkSubjectId>([
  'aether-iterate-only',
  'aether-table-storage',
  'aether-write-no-filter',
  'aether-full-change'
]);

export interface CliOptions {
  readonly profile: BenchmarkProfileName;
  readonly scenario?: BenchmarkScenarioId;
  readonly subject?: BenchmarkSubjectId;
  readonly output?: string;
}

export function parseCliOptions(args: readonly string[]): CliOptions {
  let profile: BenchmarkProfileName = 'smoke';
  let scenario: BenchmarkScenarioId | undefined;
  let subject: BenchmarkSubjectId | undefined;
  let output: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    if (!['--profile', '--scenario', '--subject', '--output'].includes(option ?? '')) {
      throw new Error(`Unknown benchmark option "${option}".`);
    }
    const value = args[index + 1];
    if (!value) throw new Error(`Benchmark option "${option}" requires a value.`);
    switch (option) {
      case '--profile':
        profile = resolveProfile(value).name;
        break;
      case '--scenario':
        if (!SCENARIOS.some((candidate) => candidate.id === value)) {
          throw new Error(`Unknown benchmark scenario "${value}".`);
        }
        scenario = value as BenchmarkScenarioId;
        break;
      case '--subject':
        if (!BENCHMARK_SUBJECTS.some((candidate) => candidate.id === value)) {
          throw new Error(`Unknown benchmark subject "${value}".`);
        }
        subject = value as BenchmarkSubjectId;
        break;
      case '--output':
        output = value;
        break;
      default:
        throw new Error(`Unknown benchmark option "${option}".`);
    }
  }
  return Object.freeze({
    profile,
    ...(scenario ? { scenario } : {}),
    ...(subject ? { subject } : {}),
    ...(output ? { output } : {})
  });
}

export async function runBenchmarks(options: CliOptions): Promise<string> {
  const seed = 0x0a37e2;
  const profile = resolveProfile(options.profile);
  const requests: BenchmarkCaseRequest[] = [];
  for (const scenario of SCENARIOS) {
    if (options.scenario && scenario.id !== options.scenario) continue;
    const scales = scenario.scales[profile.name];
    for (let round = 0; round < profile.rounds; round++) {
      for (const scale of scales) {
        for (const input of createScenarioInputs(scenario, scale, seed + round)) {
          for (const subject of BENCHMARK_SUBJECTS) {
            if (options.subject && subject.id !== options.subject) continue;
            if (DENSE_UPDATE_DIAGNOSTICS.has(subject.id) && scenario.id !== 'dense-update')
              continue;
            requests.push(
              Object.freeze({
                scenarioId: scenario.id,
                subjectId: subject.id,
                input,
                profile: profile.name,
                round
              })
            );
          }
        }
      }
    }
  }
  const results = [];
  for (const request of deterministicOrder(requests, seed)) {
    results.push(await runChildCase(request));
  }
  const report: BenchmarkReport = Object.freeze({
    schemaVersion: 1,
    profile: profile.name,
    seed,
    createdAt: new Date().toISOString(),
    environment: captureEnvironment(),
    repository: captureRepositoryState(),
    results: Object.freeze(results)
  });
  const directory = resolve(options.output ?? 'benchmark/artifacts');
  const path = writeArtifact(report, directory);
  printReport(report, path);
  return path;
}
