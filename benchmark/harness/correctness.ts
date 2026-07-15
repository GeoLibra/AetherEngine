import type { BenchmarkChecksum } from './types';

const CHECKSUM_EPSILON = 1e-6;

export function assertChecksum(
  actual: BenchmarkChecksum,
  expected: BenchmarkChecksum,
  context: string
): void {
  const tolerance = CHECKSUM_EPSILON * Math.max(1, Math.abs(expected.value));
  if (actual.count !== expected.count || Math.abs(actual.value - expected.value) > tolerance) {
    throw new Error(
      `Benchmark checksum mismatch for ${context}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`
    );
  }
}
