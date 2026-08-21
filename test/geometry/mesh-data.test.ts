import { describe, expect, test } from 'vitest';
import { validateMeshData, type MeshDataInput } from '../../src';

function triangle(): MeshDataInput {
  return {
    topology: 'triangles',
    vertexCount: 3,
    streams: [
      {
        semantic: 'POSITION',
        format: 'float32x3',
        stride: 12,
        offset: 0,
        count: 3,
        data: new Float32Array([0, 0, 0, 2, 0, 0, 0, 4, 0])
      }
    ],
    indices: { format: 'u16', data: new Uint16Array([0, 1, 2]) },
    submeshes: [{ start: 0, count: 3, materialSlot: 0 }]
  };
}

describe('MeshData validation', () => {
  test('copies canonical streams and derives deterministic bounds', () => {
    const input = triangle();
    const mesh = validateMeshData(input);
    (input.streams[0]!.data as Float32Array)[0] = 99;

    expect(Array.from(mesh.streams[0]!.data as Float32Array)).toEqual([0, 0, 0, 2, 0, 0, 0, 4, 0]);
    expect(mesh.bounds).toEqual({
      aabb: { min: [0, 0, 0], max: [2, 4, 0] },
      sphere: { center: [1, 2, 0], radius: Math.sqrt(5) }
    });
  });

  test('rejects invalid index, stream, and submesh ranges', () => {
    const base = triangle();
    expect(() =>
      validateMeshData({ ...base, indices: { format: 'u16', data: new Uint16Array([0, 1, 3]) } })
    ).toThrow(/index/i);
    expect(() =>
      validateMeshData({ ...base, streams: [{ ...base.streams[0]!, stride: 10 }] })
    ).toThrow(/stride/i);
    expect(() =>
      validateMeshData({ ...base, streams: [{ ...base.streams[0]!, count: 2 }] })
    ).toThrow(/count/i);
    expect(() =>
      validateMeshData({ ...base, submeshes: [{ ...base.submeshes[0]!, count: 4 }] })
    ).toThrow(/submesh/i);
  });

  test('rejects overlapping submeshes unless the policy explicitly allows them', () => {
    const input = triangle();
    const overlapping: MeshDataInput = {
      ...input,
      submeshes: [
        { start: 0, count: 3, materialSlot: 0 },
        { start: 0, count: 3, materialSlot: 1 }
      ]
    };
    expect(() => validateMeshData(overlapping)).toThrow(/overlap/i);
    expect(validateMeshData(overlapping, { allowSubmeshOverlap: true }).submeshes).toHaveLength(2);
  });
});
