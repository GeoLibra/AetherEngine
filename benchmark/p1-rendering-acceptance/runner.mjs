import { spawnSync } from 'node:child_process';
const profile = process.argv.at(-1);
if (!['smoke', 'standard', 'nightly'].includes(profile))
  throw new Error(`Unknown profile: ${profile}`);
const viteNode = new URL('../../node_modules/vite-node/vite-node.mjs', import.meta.url);
const runner = new URL('./run.ts', import.meta.url);
const result = spawnSync(process.execPath, [viteNode.pathname, runner.pathname, profile], {
  stdio: 'inherit'
});
process.exit(result.status ?? 1);
