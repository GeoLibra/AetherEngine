import { spawnSync } from 'node:child_process';

const profile = process.argv.at(-1);
if (profile !== 'smoke' && profile !== 'standard' && profile !== 'nightly') {
  throw new Error(`Unknown runtime/jobs benchmark profile: ${profile ?? '<missing>'}`);
}
const vitest = new URL('../node_modules/vitest/vitest.mjs', import.meta.url);
const viteNode = new URL('../node_modules/vite-node/vite-node.mjs', import.meta.url);
const integrity = new URL('./runtime-jobs/integrity-run.ts', import.meta.url);
const integrityResult = spawnSync(
  process.execPath,
  [viteNode.pathname, integrity.pathname, profile],
  {
    stdio: 'inherit'
  }
);
if (integrityResult.status !== 0) process.exit(integrityResult.status ?? 1);
const result = spawnSync(
  process.execPath,
  [vitest.pathname, 'bench', '--run', 'benchmark/runtime-jobs.bench.ts'],
  { stdio: 'inherit' }
);
process.exit(result.status ?? 1);
