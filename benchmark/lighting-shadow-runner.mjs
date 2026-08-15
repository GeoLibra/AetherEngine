import { spawnSync } from 'node:child_process';

const profile = process.argv.at(-1);
if (!['smoke', 'standard', 'nightly'].includes(profile)) {
  throw new Error(`Unknown lighting-shadow benchmark profile: ${profile ?? '<missing>'}`);
}
const vitest = new URL('../node_modules/vitest/vitest.mjs', import.meta.url);
const viteNode = new URL('../node_modules/vite-node/vite-node.mjs', import.meta.url);
const integrity = new URL('./lighting-shadow/integrity-run.ts', import.meta.url);
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
  [vitest.pathname, 'bench', '--run', 'benchmark/lighting-shadow.bench.ts'],
  { stdio: 'inherit' }
);
process.exit(result.status ?? 1);
