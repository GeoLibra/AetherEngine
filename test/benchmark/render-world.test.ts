import { describe, expect, test } from 'vitest';
import {
  createRenderPhaseWorkload,
  createPhaseConstructionWorkload,
  runPhaseConstructionSubject,
  runRenderPhaseReference,
  runRenderPhaseSubject
} from '../../benchmark/render-world/render-phase-scenario';
import {
  createPreparedDrawPhaseWorkload,
  runPreparedDrawPhaseReference,
  runPreparedDrawPhaseSubject
} from '../../benchmark/render-world/prepared-draw-phase-scenario';

describe('render-world benchmark oracle', () => {
  test('keeps prepared opaque packet ordering exact at 1K and 10K', () => {
    for (const count of [1_000, 10_000]) {
      const workload = createPreparedDrawPhaseWorkload(count);
      expect(runPreparedDrawPhaseSubject(workload)).toEqual(
        runPreparedDrawPhaseReference(workload)
      );
    }
  });

  test('constructs deterministic 1K and 10K phases without ownership transfer', () => {
    for (const count of [1_000, 10_000]) {
      const workload = createPhaseConstructionWorkload(count);
      expect(runPhaseConstructionSubject(workload)).toMatchObject({
        items: workload.expectedItems,
        skips: workload.expectedSkips,
        ownershipTransfers: 0
      });
    }
  });

  test('keeps render-phase sorting and batching exact across phase and scale axes', () => {
    for (const phase of ['opaque', 'transparent'] as const) {
      for (const count of [100, 1_000, 10_000]) {
        const workload = createRenderPhaseWorkload(count, phase, 151);
        expect(createRenderPhaseWorkload(count, phase, 151)).toEqual(workload);
        expect(runRenderPhaseSubject(workload)).toEqual(runRenderPhaseReference(workload));
      }
    }
  });
});
