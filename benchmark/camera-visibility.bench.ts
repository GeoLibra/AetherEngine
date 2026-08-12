import { bench, expect } from 'vitest';
import { createVisibilityCandidates, runVisibilitySubject } from './camera-visibility/scenario';

for (const boundsKind of ['sphere', 'aabb', 'mixed'] as const) {
  for (const count of [100, 1_000, 10_000]) {
    const candidates = createVisibilityCandidates(count, 17, boundsKind);
    bench(
      `CPU ${boundsKind} frustum scan ${count} candidates`,
      () => {
        const result = runVisibilitySubject(candidates);
        expect(result.counters.candidates).toBe(count);
        expect(result.counters.planeTests).toBeGreaterThan(0);
      },
      { iterations: 1, warmupIterations: 0 }
    );
  }
}
