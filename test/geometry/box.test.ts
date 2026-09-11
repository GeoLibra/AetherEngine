import { describe, expect, test } from 'vitest';
import { createBoxMeshData } from '../../src';

describe('built-in box mesh', () => {
  test('creates a canonical one-meter indexed box with face-local normals', () => {
    const mesh = createBoxMeshData();

    expect(mesh).toMatchObject({
      topology: 'triangles',
      frontFace: 'ccw',
      vertexCount: 24,
      submeshes: [{ start: 0, count: 36, materialSlot: 0 }],
      bounds: {
        aabb: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
        sphere: { center: [0, 0, 0], radius: Math.sqrt(0.75) }
      }
    });
    expect(
      mesh.streams.map(({ semantic, format, count }) => ({ semantic, format, count }))
    ).toEqual([
      { semantic: 'POSITION', format: 'float32x3', count: 24 },
      { semantic: 'NORMAL', format: 'float32x3', count: 24 },
      { semantic: 'TEXCOORD_0', format: 'float32x2', count: 24 },
      { semantic: 'TEXCOORD_1', format: 'float32x2', count: 24 },
      { semantic: 'TANGENT', format: 'float32x4', count: 24 }
    ]);
    expect(mesh.indices?.format).toBe('u16');
    expect(mesh.indices?.data).toHaveLength(36);

    const normals = Array.from(mesh.streams[1]!.data as Float32Array);
    for (let face = 0; face < 6; face += 1) {
      const normal = normals.slice(face * 12, face * 12 + 3);
      expect(normals.slice(face * 12, face * 12 + 12)).toEqual([
        ...normal,
        ...normal,
        ...normal,
        ...normal
      ]);
    }
  });

  test('scales dimensions in meters and isolates returned payloads', () => {
    const first = createBoxMeshData({ width: 2, height: 4, depth: 6 });
    const second = createBoxMeshData({ width: 2, height: 4, depth: 6 });

    expect(first.bounds.aabb).toEqual({ min: [-1, -2, -3], max: [1, 2, 3] });
    expect(first.bounds.sphere.radius).toBe(Math.sqrt(14));
    (first.streams[0]!.data as Float32Array)[0] = 99;
    (first.indices!.data as Uint16Array)[0] = 23;
    expect((second.streams[0]!.data as Float32Array)[0]).not.toBe(99);
    expect(second.indices!.data[0]).not.toBe(23);
  });

  test.each([
    [{ width: 0 }, 'width'],
    [{ height: -1 }, 'height'],
    [{ depth: Number.NaN }, 'depth'],
    [{ width: Number.POSITIVE_INFINITY }, 'width']
  ] as const)('rejects invalid dimensions %o', (options, label) => {
    expect(() => createBoxMeshData(options)).toThrow(
      `Box ${label} must be a positive finite number of meters.`
    );
  });
});
