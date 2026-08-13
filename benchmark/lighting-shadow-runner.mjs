import { spawnSync } from 'node:child_process';

const profile = process.argv.at(-1);
if (!['smoke', 'standard', 'nightly'].includes(profile)) {
  throw new Error(`Unknown lighting-shadow benchmark profile: ${profile ?? '<missing>'}`);
}
const vitest = new URL('../node_modules/vitest/vitest.mjs', import.meta.url);
const result = spawnSync(
  process.execPath,
  [vitest.pathname, 'bench', '--run', 'benchmark/lighting-shadow.bench.ts'],
  { stdio: 'inherit' }
);
process.exit(result.status ?? 1);
