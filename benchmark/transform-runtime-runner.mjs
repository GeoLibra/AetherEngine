import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertTransformBenchmarkSamples } from './transform-runtime-runner-guard.mjs';

const profile = process.argv.at(-1);
if (!['smoke', 'standard', 'nightly'].includes(profile)) {
  throw new Error(`Unknown transform-runtime benchmark profile: ${profile ?? '<missing>'}`);
}
const vitest = new URL('../node_modules/vitest/vitest.mjs', import.meta.url);
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'aether-transform-bench-'));
const reportPath = join(temporaryDirectory, 'report.json');
try {
  const result = spawnSync(
    process.execPath,
    [
      vitest.pathname,
      'bench',
      '--run',
      'benchmark/transform-runtime.bench.ts',
      '--outputJson',
      reportPath
    ],
    { stdio: 'inherit' }
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  assertTransformBenchmarkSamples(JSON.parse(readFileSync(reportPath, 'utf8')));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
