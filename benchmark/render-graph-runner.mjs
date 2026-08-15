import { spawnSync } from 'node:child_process';

const profile = process.argv.at(-1);
if (profile !== 'smoke' && profile !== 'standard' && profile !== 'nightly') {
  throw new Error(`Unknown render-graph benchmark profile: ${profile ?? '<missing>'}`);
}
const viteNode = new URL('../node_modules/vite-node/vite-node.mjs', import.meta.url);
const integrity = new URL('./render-graph/integrity-run.ts', import.meta.url);
const integrityResult = spawnSync(
  process.execPath,
  [viteNode.pathname, integrity.pathname, profile],
  {
    stdio: 'inherit'
  }
);
if (integrityResult.status !== 0) process.exit(integrityResult.status ?? 1);
const runner = new URL('./render-graph/run.ts', import.meta.url);
const result = spawnSync(process.execPath, [viteNode.pathname, runner.pathname], {
  stdio: 'inherit',
  env: { ...process.env, AETHER_RENDER_GRAPH_BENCH_PROFILE: profile }
});
process.exit(result.status ?? 1);
