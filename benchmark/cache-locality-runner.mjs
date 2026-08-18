import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const viteNode = new URL('../node_modules/vite-node/vite-node.mjs', import.meta.url);
const target = new URL('./cache-locality.bench.ts', import.meta.url);

const result = spawnSync(process.execPath, [fileURLToPath(viteNode), fileURLToPath(target)], {
  stdio: 'inherit'
});

process.exit(result.status ?? 0);
