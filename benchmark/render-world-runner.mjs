import { spawnSync } from 'node:child_process';

const profile = process.argv.at(-1);
if (profile !== 'smoke' && profile !== 'standard' && profile !== 'nightly') {
  throw new Error(`Unknown render-world benchmark profile: ${profile ?? '<missing>'}`);
}
const vitest = new URL('../node_modules/vitest/vitest.mjs', import.meta.url);
const result = spawnSync(process.execPath, [vitest.pathname, 'bench', '--run', 'benchmark/render-world.bench.ts'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
