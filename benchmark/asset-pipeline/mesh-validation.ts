import { validateMeshData, type MeshDataInput } from '../../src/geometry';

export function createMeshValidationFixture(vertexCount: number): MeshDataInput {
  if (vertexCount % 3 !== 0)
    throw new Error('Mesh benchmark vertex count must be divisible by three.');
  const positions = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(vertexCount);
  for (let index = 0; index < vertexCount; index += 1) {
    positions[index * 3] = index;
    positions[index * 3 + 1] = index % 17;
    positions[index * 3 + 2] = -(index % 11);
    indices[index] = index;
  }
  return {
    topology: 'triangles',
    vertexCount,
    streams: [
      {
        semantic: 'POSITION',
        format: 'float32x3',
        stride: 12,
        offset: 0,
        count: vertexCount,
        data: positions
      }
    ],
    indices: { format: 'u32', data: indices },
    submeshes: [{ start: 0, count: vertexCount, materialSlot: 0 }]
  };
}

export function validateMeshFixture(fixture: MeshDataInput): string {
  const mesh = validateMeshData(fixture);
  return JSON.stringify({
    vertices: mesh.vertexCount,
    indices: mesh.indices?.data.length ?? 0,
    min: mesh.bounds.aabb.min,
    max: mesh.bounds.aabb.max,
    radius: mesh.bounds.sphere.radius
  });
}

export function meshFixtureReferenceOracle(vertexCount: number): string {
  const min = [0, 0, -Math.min(10, vertexCount - 1)] as const;
  const max = [vertexCount - 1, Math.min(16, vertexCount - 1), 0] as const;
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] as const;
  let radiusSquared = 0;
  for (let index = 0; index < vertexCount; index += 1) {
    const dx = index - center[0];
    const dy = (index % 17) - center[1];
    const dz = -(index % 11) - center[2];
    radiusSquared = Math.max(radiusSquared, dx * dx + dy * dy + dz * dz);
  }
  return JSON.stringify({
    vertices: vertexCount,
    indices: vertexCount,
    min,
    max,
    radius: Math.sqrt(radiusSquared)
  });
}
