/** Fails closed because Vitest reports a successful process for a lane with no collected samples. */
export function assertTransformBenchmarkSamples(report) {
  const benchmarks = report?.files?.flatMap(
    (file) => file.groups?.flatMap((group) => group.benchmarks ?? []) ?? []
  );
  if (!Array.isArray(benchmarks) || benchmarks.length === 0) {
    throw new Error('Transform benchmark report contains no lanes.');
  }
  for (const benchmark of benchmarks) {
    const sampleCount =
      Array.isArray(benchmark.samples) && benchmark.samples.length > 0
        ? benchmark.samples.length
        : benchmark.sampleCount;
    if (!Number.isInteger(sampleCount) || sampleCount <= 0) {
      throw new Error(
        `Transform benchmark lane "${benchmark.name ?? '<unknown>'}" has zero finite samples.`
      );
    }
    const values =
      Array.isArray(benchmark.samples) && benchmark.samples.length > 0
        ? benchmark.samples
        : [benchmark.min, benchmark.max, benchmark.mean, benchmark.hz, benchmark.totalTime];
    if (!values.every((sample) => Number.isFinite(sample) && sample > 0)) {
      throw new Error(
        `Transform benchmark lane "${benchmark.name ?? '<unknown>'}" has non-finite samples.`
      );
    }
  }
}
