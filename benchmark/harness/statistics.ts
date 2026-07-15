import type { BenchmarkSummary } from './types';

export function summarize(samples: readonly number[]): BenchmarkSummary {
  if (samples.length === 0) {
    throw new Error('Benchmark summary requires at least one sample.');
  }
  if (samples.some((sample) => !Number.isFinite(sample))) {
    throw new Error('Benchmark samples must be finite numbers.');
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const mean = sorted.reduce((sum, sample) => sum + sample, 0) / sorted.length;
  const median = percentile(sorted, 0.5);
  const deviations = sorted
    .map((sample) => Math.abs(sample - median))
    .sort((left, right) => left - right);

  return Object.freeze({
    count: sorted.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean,
    median,
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    mad: percentile(deviations, 0.5)
  });
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (fraction === 0.5 && sorted.length % 2 === 0) {
    const upperIndex = sorted.length / 2;
    return (sorted[upperIndex - 1]! + sorted[upperIndex]!) / 2;
  }
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index]!;
}
