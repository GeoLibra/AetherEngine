import { spawnSync } from 'node:child_process';

const profile = process.argv.at(-1);
if (!['smoke', 'standard', 'nightly'].includes(profile)) {
  throw new Error(`Unknown simulation-vfx benchmark profile: ${profile ?? '<missing>'}`);
}
const vitest = new URL('../node_modules/vitest/vitest.mjs', import.meta.url);
const result = spawnSync(
  process.execPath,
  [vitest.pathname, 'bench', '--run', 'benchmark/simulation-vfx.bench.ts'],
  {
    stdio: 'inherit',
    env: { ...process.env, AETHER_BENCH_PROFILE: profile }
  }
);
process.exit(result.status ?? 1);
