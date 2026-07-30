import { spawnSync } from 'node:child_process';

const profile = process.argv.at(-1);
if (profile !== 'smoke' && profile !== 'standard' && profile !== 'nightly') {
  throw new Error(`Unknown asset-pipeline benchmark profile: ${profile ?? '<missing>'}`);
}
const vitest = new URL('../node_modules/vitest/vitest.mjs', import.meta.url);
const result = spawnSync(
  process.execPath,
  [vitest.pathname, 'bench', '--run', 'benchmark/asset-pipeline.bench.ts'],
  {
    stdio: 'inherit',
    env: { ...process.env, AETHER_BENCH_PROFILE: profile }
  }
);
process.exit(result.status ?? 1);
