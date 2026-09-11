import { validateMeshData } from './mesh-data';
import type { BoxMeshOptions, MeshData } from './types';

const FACE_INDICES = Object.freeze([0, 1, 2, 0, 2, 3] as const);

/**
 * Creates an indexed box with face-local POSITION and NORMAL streams.
 *
 * Dimensions use engine meters and default to one meter. Vertices use counter-clockwise winding
 * when viewed from outside the box, with one material-selectable submesh.
 *
 * @throws When any supplied dimension is not a positive finite number.
 */
export function createBoxMeshData(options: BoxMeshOptions = {}): MeshData {
  const width = dimension(options.width, 'width');
  const height = dimension(options.height, 'height');
  const depth = dimension(options.depth, 'depth');
  const x = width / 2;
  const y = height / 2;
  const z = depth / 2;
  const positions = new Float32Array([
    x,
    -y,
    -z,
    x,
    y,
    -z,
    x,
    y,
    z,
    x,
    -y,
    z,
    -x,
    -y,
    z,
    -x,
    y,
    z,
    -x,
    y,
    -z,
    -x,
    -y,
    -z,
    -x,
    y,
    -z,
    -x,
    y,
    z,
    x,
    y,
    z,
    x,
    y,
    -z,
    -x,
    -y,
    z,
    -x,
    -y,
    -z,
    x,
    -y,
    -z,
    x,
    -y,
    z,
    -x,
    -y,
    z,
    x,
    -y,
    z,
    x,
    y,
    z,
    -x,
    y,
    z,
    x,
    -y,
    -z,
    -x,
    -y,
    -z,
    -x,
    y,
    -z,
    x,
    y,
    -z
  ]);
  const normals = new Float32Array([
    ...faceNormal(1, 0, 0),
    ...faceNormal(-1, 0, 0),
    ...faceNormal(0, 1, 0),
    ...faceNormal(0, -1, 0),
    ...faceNormal(0, 0, 1),
    ...faceNormal(0, 0, -1)
  ]);
  const uv0 = new Float32Array(Array.from({ length: 6 }, () => [0, 0, 0, 1, 1, 1, 1, 0]).flat());
  const uv1 = new Float32Array(uv0);
  const tangentDirections = [
    [0, 0, 1],
    [0, 0, -1],
    [1, 0, 0],
    [1, 0, 0],
    [1, 0, 0],
    [-1, 0, 0]
  ] as const;
  const tangents = new Float32Array(
    tangentDirections.flatMap(([xDirection, yDirection, zDirection]) =>
      Array.from({ length: 4 }, () => [xDirection, yDirection, zDirection, 1]).flat()
    )
  );
  const indices = new Uint16Array(
    Array.from({ length: 6 }, (_, face) => FACE_INDICES.map((index) => index + face * 4)).flat()
  );

  return validateMeshData({
    topology: 'triangles',
    frontFace: 'ccw',
    vertexCount: 24,
    streams: [
      {
        semantic: 'POSITION',
        format: 'float32x3',
        stride: 12,
        offset: 0,
        count: 24,
        data: positions
      },
      {
        semantic: 'NORMAL',
        format: 'float32x3',
        stride: 12,
        offset: 0,
        count: 24,
        data: normals
      },
      {
        semantic: 'TEXCOORD_0',
        format: 'float32x2',
        stride: 8,
        offset: 0,
        count: 24,
        data: uv0
      },
      {
        semantic: 'TEXCOORD_1',
        format: 'float32x2',
        stride: 8,
        offset: 0,
        count: 24,
        data: uv1
      },
      {
        semantic: 'TANGENT',
        format: 'float32x4',
        stride: 16,
        offset: 0,
        count: 24,
        data: tangents
      }
    ],
    indices: { format: 'u16', data: indices },
    submeshes: [{ start: 0, count: 36, materialSlot: 0 }]
  });
}

function dimension(value: number | undefined, label: 'width' | 'height' | 'depth'): number {
  const resolved = value ?? 1;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`Box ${label} must be a positive finite number of meters.`);
  }
  return resolved;
}

function faceNormal(x: number, y: number, z: number): readonly number[] {
  return [x, y, z, x, y, z, x, y, z, x, y, z];
}
