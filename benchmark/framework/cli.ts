import { parseFrameworkCliOptions } from './cli-options';
import { collectChangedFiles } from './git-changes';
import { BENCHMARK_MANIFEST } from './manifest';
import { runBenchmarkPlan } from './runner';
import { validateManifest } from './validation';

const options = parseFrameworkCliOptions(process.argv.slice(2));
const validation = validateManifest(BENCHMARK_MANIFEST);
if (validation.errors.length > 0) {
  throw new Error(`Invalid benchmark manifest:\n- ${validation.errors.join('\n- ')}`);
}

if (options.command === 'validate') {
  console.log('Benchmark manifest is valid.');
  console.log(`Registered suites: ${BENCHMARK_MANIFEST.suites.map((suite) => suite.id).join(', ') || 'none'}`);
  console.log(`Coverage gaps: ${validation.uncoveredDomainIds.join(', ') || 'none'}`);
} else {
  const files = options.command === 'changed'
    ? options.files ?? await collectChangedFiles(options.base)
    : [];
  const result = await runBenchmarkPlan(BENCHMARK_MANIFEST, {
    mode: options.command,
    profile: options.profile,
    files,
    dryRun: options.dryRun
  });
  if (result.suiteIds.length === 0) {
    console.log('No benchmark suite matched this change.');
  } else {
    console.log(`${options.dryRun ? 'Selected' : 'Completed'} benchmark suites: ${result.suiteIds.join(', ')}`);
    for (const command of result.commands) {
      console.log(`- ${command.executable} ${command.args.join(' ')}`);
    }
    for (const output of result.outputs) {
      if (output.stdout.trim()) console.log(output.stdout.trim());
      if (output.stderr.trim()) console.error(output.stderr.trim());
    }
  }
}
