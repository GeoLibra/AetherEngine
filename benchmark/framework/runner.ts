import { runCommand, type CommandResult } from '../core/process';
import { routeChangedFiles } from './routing';
import type {
  BenchmarkManifest,
  BenchmarkRunProfile,
  BenchmarkSuiteDefinition,
  RenderedBenchmarkCommand
} from './types';
import { assertValidManifest } from './validation';

type CommandRunner = (command: string, args: readonly string[]) => Promise<CommandResult>;

export interface BenchmarkPlanOptions {
  readonly mode: 'changed' | 'all';
  readonly profile: BenchmarkRunProfile;
  readonly files: readonly string[];
  readonly dryRun: boolean;
}

export interface BenchmarkPlanResult {
  readonly suiteIds: readonly string[];
  readonly commands: readonly RenderedBenchmarkCommand[];
  readonly outputs: readonly CommandResult[];
}

export function renderSuiteCommand(
  suite: BenchmarkSuiteDefinition,
  profile: BenchmarkRunProfile
): RenderedBenchmarkCommand {
  return Object.freeze({
    executable: suite.command.executable,
    args: Object.freeze(suite.command.args.map((argument) => argument === '{profile}' ? profile : argument))
  });
}

export async function runBenchmarkPlan(
  manifest: BenchmarkManifest,
  options: BenchmarkPlanOptions,
  execute: CommandRunner = runCommand
): Promise<BenchmarkPlanResult> {
  assertValidManifest(manifest);
  const route = routeChangedFiles(manifest, options.files);
  if (options.mode === 'changed' && route.missingDomainIds.length > 0) {
    throw new Error(
      `Performance benchmark coverage is missing for changed domain(s): ${route.missingDomainIds.join(', ')}. `
      + 'Add a semantic suite to benchmark/framework/manifest.ts before completing this change.'
    );
  }
  const selectedIds = options.mode === 'all'
    ? manifest.suites.map((suite) => suite.id)
    : route.suiteIds;
  const selected = manifest.suites.filter((suite) => selectedIds.includes(suite.id));
  const commands = selected.map((suite) => renderSuiteCommand(suite, options.profile));
  const outputs: CommandResult[] = [];
  if (!options.dryRun) {
    for (const command of commands) {
      outputs.push(await execute(command.executable, command.args));
    }
  }
  return Object.freeze({
    suiteIds: Object.freeze(selected.map((suite) => suite.id)),
    commands: Object.freeze(commands),
    outputs: Object.freeze(outputs)
  });
}
