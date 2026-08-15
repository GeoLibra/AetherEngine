import { describe, expect, test } from 'vitest';
import {
  createRenderPhaseWorkload,
  runRenderPhaseReference,
  runRenderPhaseSubject
} from '../../benchmark/render-world/render-phase-scenario';

describe('render-world benchmark oracle', () => {
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
