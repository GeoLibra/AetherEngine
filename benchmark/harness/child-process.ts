import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runCommand } from '../core/process';
import type { BenchmarkCaseRequest, BenchmarkResult } from './types';

export { runCommand, type CommandResult } from '../core/process';

const RESULT_PREFIX = 'AETHER_BENCHMARK_RESULT=';

export async function runChildCase(request: BenchmarkCaseRequest): Promise<BenchmarkResult> {
  const harnessDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(harnessDirectory, '..', '..');
  const viteNode = resolve(repositoryRoot, 'node_modules', 'vite-node', 'vite-node.mjs');
  const worker = resolve(repositoryRoot, 'benchmark', 'worker.ts');
  const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64url');
  const result = await runCommand(process.execPath, [viteNode, worker, encoded]);
  const line = result.stdout
    .split('\n')
    .reverse()
    .find((candidate) => candidate.startsWith(RESULT_PREFIX));
  if (!line) {
    throw new Error(`Benchmark child returned no result record. stdout: ${result.stdout.trim()}`);
  }
  return JSON.parse(line.slice(RESULT_PREFIX.length)) as BenchmarkResult;
}

export function formatWorkerResult(result: BenchmarkResult): string {
  return `${RESULT_PREFIX}${JSON.stringify(result)}`;
}
