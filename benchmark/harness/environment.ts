import { arch, cpus, platform, release, totalmem } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { BenchmarkEnvironment, BenchmarkRepositoryState } from './types';

export function captureEnvironment(): BenchmarkEnvironment {
  const processors = cpus();
  return Object.freeze({
    node: process.version,
    v8: process.versions.v8,
    platform: platform(),
    release: release(),
    architecture: arch(),
    cpu: processors[0]?.model ?? 'unknown',
    logicalCpuCount: processors.length,
    totalMemoryBytes: totalmem()
  });
}

export function captureRepositoryState(cwd = process.cwd()): BenchmarkRepositoryState {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['status', '--short'], { cwd, encoding: 'utf8' });
  return Object.freeze({ commit, dirty: status.trim().length > 0 });
}
