import { describe, expect, test } from 'vitest';
import { transformTangentFrame } from '../../src';

describe('world tangent frame', () => {
  test('re-orthogonalizes the tangent and preserves a right-handed frame', () => {
    const frame = transformTangentFrame({
      normal: [0, 0, 1],
      tangent: [1, 0, 0, 1],
      worldMatrix: [2, 0, 0, 0, 1, 0, 0.5, 0, 1],
      normalMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1]
    });
    expect(frame.normal).toEqual([0, 0, 1]);
    expect(frame.tangent).toEqual([1, 0, 0]);
    expect(frame.bitangent).toEqual([0, 1, 0]);
  });

  test.each([
    { tangentW: -1 as const, worldX: 1, expectedY: -1 },
    { tangentW: 1 as const, worldX: -1, expectedY: 1 },
    { tangentW: -1 as const, worldX: -1, expectedY: -1 }
  ])('combines authored and transform handedness: %o', ({ tangentW, worldX, expectedY }) => {
    const frame = transformTangentFrame({
      normal: [0, 0, 1],
      tangent: [1, 0, 0, tangentW],
      worldMatrix: [worldX, 0, 0, 0, 1, 0, 0, 0, 1],
      normalMatrix: [1 / worldX, 0, 0, 0, 1, 0, 0, 0, 1]
    });
    expect(frame.bitangent).toEqual([0, expectedY, 0]);
  });
});
