import { describe, expect, test } from 'vitest';
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
} from '../../benchmark/lighting-shadow/scenario';
import {
  assertDeclaredShadowLayers,
  createShadowDeclarationWorkload
} from '../../benchmark/lighting-shadow/declaration-scenario';

describe('lighting-shadow benchmark oracle', () => {
  test('checks every declaration key against an independent stable-layer oracle', () => {
    const workload = createShadowDeclarationWorkload(64);
    expect(createShadowDeclarationWorkload(64)).toEqual(workload);
    expect(assertDeclaredShadowLayers(workload)).toEqual(workload.expectedLayers);
  });

  test('keeps shadow selection exact across the declared request scale axis', () => {
    for (const count of [100, 1_000, 10_000]) {
      const workload = createShadowSelectionWorkload(count, 127);
      expect(createShadowSelectionWorkload(count, 127)).toEqual(workload);
      expect(runShadowSelectionSubject(workload)).toEqual(runShadowSelectionReference(workload));
    }
  });

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

  test('executes atlas compaction with deterministic relocation and generation evidence', () => {
    for (const count of [4, 16, 64]) {
      const subject = runShadowAtlasCompactionSubject(count, 16);

      expect(subject).toEqual(runShadowAtlasCompactionReference(count, 16));
      expect(subject.counters).toEqual({
        inputTiles: count,
        relocations: count,
        validNextHandles: count,
        invalidPreviousHandles: count
      });
      expect(subject.checksum).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});
