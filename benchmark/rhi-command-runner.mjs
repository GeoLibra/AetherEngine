import { spawnSync } from 'node:child_process';

const profile = process.argv.at(-1);
if (profile !== 'smoke' && profile !== 'standard' && profile !== 'nightly') {
  throw new Error(`Unknown RHI benchmark profile: ${profile ?? '<missing>'}`);
}
const vitest = new URL('../node_modules/vitest/vitest.mjs', import.meta.url);
const result = spawnSync(
  process.execPath,
  [vitest.pathname, 'bench', '--run', 'benchmark/rhi-command.bench.ts'],
  {
    stdio: 'inherit',
    env: { ...process.env, AETHER_BENCH_PROFILE: profile }
  }
);
if (result.status !== 0) process.exit(result.status ?? 1);
if (profile === 'standard' || profile === 'nightly') {
  const viteNode = new URL('../node_modules/vite-node/vite-node.mjs', import.meta.url);
  const artifact = new URL('./rhi-standard-artifact.ts', import.meta.url);
  const artifactResult = spawnSync(
    process.execPath,
    [viteNode.pathname, artifact.pathname, profile],
    {
      stdio: 'inherit'
    }
  );
  process.exit(artifactResult.status ?? 1);
}
