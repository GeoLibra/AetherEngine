import { bench, expect } from 'vitest';
import {
  createLightingWorkload,
  createShadowSelectionWorkload,
  runLightingReference,
  runLightingSubject,
  runShadowAtlasCompactionReference,
  runShadowAtlasCompactionSubject,
  runShadowAtlasReference,
  runShadowAtlasSubject,
  runShadowSelectionReference,
  runShadowSelectionSubject
} from './lighting-shadow/scenario';

for (const count of [100, 1_000, 10_000]) {
  const workload = createShadowSelectionWorkload(count);
  const reference = runShadowSelectionReference(workload);
  bench(
    `shadow request selection ${count} requests`,
    () => expect(runShadowSelectionSubject(workload)).toEqual(reference),
    { iterations: 1, warmupIterations: 0 }
  );
}

for (const receiverCount of [100, 1_000, 10_000]) {
  const workload = createLightingWorkload(receiverCount, 32, 71);
  const reference = runLightingReference(workload);
  bench(
    `CPU light list ${receiverCount} receivers x 32 lights`,
    () => {
      const subject = runLightingSubject(workload);
      expect(subject).toEqual(reference);
      expect(subject.counters.candidatePairs).toBeGreaterThan(0);
    },
    { iterations: 1, warmupIterations: 0 }
  );
}

const constrained = createLightingWorkload(1_000, 128, 97, true);
const constrainedReference = runLightingReference(constrained);
bench(
  'CPU light list constrained overflow 1000 receivers x 128 lights',
  () => {
    const subject = runLightingSubject(constrained);
    expect(subject).toEqual(constrainedReference);
    expect(subject.counters.truncatedIndices).toBeGreaterThan(0);
  },
  { iterations: 1, warmupIterations: 0 }
);

for (const count of [16, 64, 256]) {
  const reference = runShadowAtlasCompactionReference(count, 16);
  bench(
    `shadow atlas compaction ${count} uniform tiles`,
    () => {
      const subject = runShadowAtlasCompactionSubject(count, 16);
      expect(subject).toEqual(reference);
      expect(subject.counters.relocations).toBe(count);
    },
    { iterations: 1, warmupIterations: 0 }
  );
}

const atlasReference = runShadowAtlasReference(32, 32, 32);
bench(
  'shadow atlas allocation and lower-hole reclamation for 1024 uniform tiles',
  () => {
    expect(runShadowAtlasSubject(32, 32, 32)).toEqual(atlasReference);
  },
  { iterations: 1, warmupIterations: 0 }
);
