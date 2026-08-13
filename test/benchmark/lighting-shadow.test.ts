import { describe, expect, test } from 'vitest';
import {
  createLightingWorkload,
  runLightingReference,
  runLightingSubject,
  runShadowAtlasReference,
  runShadowAtlasSubject
} from '../../benchmark/lighting-shadow/scenario';

describe('lighting-shadow benchmark oracle', () => {
  test('generates deterministic workloads and agrees with the independent scalar oracle', () => {
    for (const constrained of [false, true]) {
      const workload = createLightingWorkload(256, 48, 83, constrained);
      expect(createLightingWorkload(256, 48, 83, constrained)).toEqual(workload);
      const subject = runLightingSubject(workload);
      expect(subject).toEqual(runLightingReference(workload));
      expect(subject.counters.candidatePairs).toBeGreaterThan(0);
      expect(subject.counters.intersectionTests).toBe(subject.counters.candidatePairs);
      if (constrained) expect(subject.counters.truncatedIndices).toBeGreaterThan(0);
    }
  });

  test('preserves exact output across the declared receiver scale axis', () => {
    for (const count of [100, 1_000, 10_000]) {
      const workload = createLightingWorkload(count, 16, 101);
      const subject = runLightingSubject(workload);
      expect(subject).toEqual(runLightingReference(workload));
      expect(subject.receivers.length).toBeLessThanOrEqual(count);
    }
  });

  test('matches the independent atlas placement and generation oracle', () => {
    for (const columns of [2, 8, 16]) {
      const subject = runShadowAtlasSubject(columns, columns, 32);
      expect(subject).toEqual(runShadowAtlasReference(columns, columns, 32));
      expect(subject.reclaimedLowerHole).toBe(true);
      expect(subject.staleAfterInvalidate).toBe(true);
    }
  });
});
