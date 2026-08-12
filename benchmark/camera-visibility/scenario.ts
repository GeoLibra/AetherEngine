import { Frustum, Mat4 } from '../../src/math';
import {
  computeVisibility,
  type RenderEntityId,
  type VisibilityCandidate
} from '../../src/rendering';

export function createVisibilityCandidates(
  count: number,
  seed = 17,
  boundsKind: 'sphere' | 'aabb' | 'mixed' = 'sphere'
): readonly VisibilityCandidate[] {
  let state = seed >>> 0;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000;
  return Object.freeze(
    Array.from({ length: count }, (_, index) => {
      const center = [(random() - 0.5) * 30, (random() - 0.5) * 20, -random() * 40 - 0.1] as const;
      const radius = 0.05 + random();
      const useAabb = boundsKind === 'aabb' || (boundsKind === 'mixed' && index % 2 === 1);
      return Object.freeze({
        entity: index as RenderEntityId,
        layerMask: index % 7 === 0 ? 2 : 1,
        bounds: useAabb
          ? {
              kind: 'aabb' as const,
              min: [center[0] - radius, center[1] - radius, center[2] - radius] as const,
              max: [center[0] + radius, center[1] + radius, center[2] + radius] as const
            }
          : { kind: 'sphere' as const, center, radius }
      });
    })
  );
}

export function runVisibilitySubject(candidates: readonly VisibilityCandidate[]) {
  const frustum = Frustum.fromViewProjection(Mat4.perspective(Math.PI / 2, 16 / 9, 0.1, 50));
  return computeVisibility(
    {
      id: 'bench',
      camera: 0 as RenderEntityId,
      surface: 'headless',
      viewport: { x: 0, y: 0, width: 1920, height: 1080 },
      layerMask: 1,
      featurePolicyKey: 'cpu',
      historyKey: 'bench',
      frustum
    },
    candidates
  );
}

export function runVisibilityReference(
  candidates: readonly VisibilityCandidate[]
): readonly RenderEntityId[] {
  const matrix = Mat4.perspective(Math.PI / 2, 16 / 9, 0.1, 50);
  const row = (index: number) =>
    [matrix[index]!, matrix[index + 4]!, matrix[index + 8]!, matrix[index + 12]!] as const;
  const combine = (left: readonly number[], right: readonly number[], sign = 1) =>
    left.map((value, index) => value + sign * right[index]!) as number[];
  const row0 = row(0),
    row1 = row(1),
    row2 = row(2),
    row3 = row(3);
  const planes = [
    combine(row3, row0),
    combine(row3, row0, -1),
    combine(row3, row1),
    combine(row3, row1, -1),
    [...row2],
    combine(row3, row2, -1)
  ];
  return Object.freeze(
    candidates
      .filter((candidate) => candidate.layerMask === 1)
      .filter((candidate) => {
        const bounds = candidate.bounds!;
        return planes.every((plane) => {
          if (bounds.kind === 'sphere') {
            const [x, y, z] = bounds.center;
            return (
              plane[0]! * x + plane[1]! * y + plane[2]! * z + plane[3]! >=
              -bounds.radius * Math.hypot(plane[0]!, plane[1]!, plane[2]!)
            );
          }
          const x = plane[0]! >= 0 ? bounds.max[0] : bounds.min[0];
          const y = plane[1]! >= 0 ? bounds.max[1] : bounds.min[1];
          const z = plane[2]! >= 0 ? bounds.max[2] : bounds.min[2];
          return plane[0]! * x + plane[1]! * y + plane[2]! * z + plane[3]! >= 0;
        });
      })
      .map((candidate) => candidate.entity)
      .sort((a, b) => a - b)
  );
}
