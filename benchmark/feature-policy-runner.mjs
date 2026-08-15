import { spawnSync } from 'node:child_process';

const profile = process.argv.at(-1);
if (!['smoke', 'standard', 'nightly'].includes(profile))
  throw new Error(`Unknown FeaturePolicy benchmark profile: ${profile ?? '<missing>'}`);
const viteNode = new URL('../node_modules/vite-node/vite-node.mjs', import.meta.url);
const runner = new URL('./feature-policy/run.ts', import.meta.url);
const result = spawnSync(process.execPath, [viteNode.pathname, runner.pathname], {
  stdio: 'inherit',
  env: { ...process.env, AETHER_FEATURE_POLICY_BENCH_PROFILE: profile }
});
process.exit(result.status ?? 1);
