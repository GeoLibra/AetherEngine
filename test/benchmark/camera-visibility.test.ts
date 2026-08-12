import { describe, expect, test } from 'vitest';
import {
  createVisibilityCandidates,
  runVisibilityReference,
  runVisibilitySubject
} from '../../benchmark/camera-visibility/scenario';

describe('camera visibility benchmark oracle', () => {
  test('generates deterministic workloads and agrees with the independent clip oracle', () => {
    for (const kind of ['sphere', 'aabb', 'mixed'] as const) {
      const candidates = createVisibilityCandidates(256, 23, kind);
      expect(createVisibilityCandidates(256, 23, kind)).toEqual(candidates);
      const subject = runVisibilitySubject(candidates);
      expect(subject.entities).toEqual(runVisibilityReference(candidates));
      expect(subject.counters).toMatchObject({
        candidates: 256,
        conservativeFallbackRetained: 0
      });
      expect(subject.counters.planeTests).toBeGreaterThan(subject.counters.retained);
    }
  });
});
