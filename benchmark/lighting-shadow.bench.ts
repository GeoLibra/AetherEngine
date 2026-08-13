import { bench, expect } from 'vitest';
import {
  createLightingWorkload,
  runLightingReference,
  runLightingSubject,
  runShadowAtlasReference,
  runShadowAtlasSubject
} from './lighting-shadow/scenario';

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

const atlasReference = runShadowAtlasReference(32, 32, 32);
bench(
  'shadow atlas allocation and lower-hole reclamation for 1024 uniform tiles',
  () => {
    expect(runShadowAtlasSubject(32, 32, 32)).toEqual(atlasReference);
  },
  { iterations: 1, warmupIterations: 0 }
);
