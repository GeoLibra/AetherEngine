import { bench, expect } from 'vitest';
import {
  assertTransformExtractPreflight,
  createTransformExtractWorkload,
  runTransformExtractSubject
} from './transform-runtime-scenario';

for (const count of [100, 1_000, 10_000]) {
  const workload = createTransformExtractWorkload(count);
  // Correctness executes outside timing too: a benchmark cannot report a valid empty lane.
  assertTransformExtractPreflight(workload);
  bench(
    `extracts ${count} detached transform matrices`,
    () => expect(runTransformExtractSubject(workload)).toEqual(workload.expected),
    { iterations: 3, warmupIterations: 1 }
  );
}
