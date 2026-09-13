import type { CanonicalMeshDocument } from '../../src/assets/canonical/types';
import type { AssetId } from '../../src/assets/types';
import { adaptGltfToCanonical, parseGlbContainer } from '../../src/assets/importers/gltf';

export interface GlbIngestBenchmarkResult {
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly copiedBytes: number;
  readonly checksum: number;
}

/**
 * Creates a deterministic synthetic GLB binary fixture with a grid of triangle meshes.
 */
export function createSyntheticGlbFixture(vertexCount: number): Uint8Array {
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);

  for (let i = 0; i < vertexCount; i += 1) {
    positions[i * 3] = (i % 100) * 0.1;
    positions[i * 3 + 1] = Math.floor(i / 100) * 0.1;
    positions[i * 3 + 2] = (i % 7) * 0.05;

    normals[i * 3] = 0;
    normals[i * 3 + 1] = 0;
    normals[i * 3 + 2] = 1;

    uvs[i * 2] = (i % 100) / 100;
    uvs[i * 2 + 1] = Math.floor(i / 100) / 100;
  }

  const indexCount = Math.floor(vertexCount / 3) * 3;
  const indices = new Uint16Array(indexCount);
  for (let i = 0; i < indexCount; i += 1) {
    indices[i] = i;
  }

  const binChunk = new Uint8Array(
    positions.byteLength + normals.byteLength + uvs.byteLength + indices.byteLength
  );
  let offset = 0;
  binChunk.set(new Uint8Array(positions.buffer), offset);
  offset += positions.byteLength;
  binChunk.set(new Uint8Array(normals.buffer), offset);
  offset += normals.byteLength;
  binChunk.set(new Uint8Array(uvs.buffer), offset);
  offset += uvs.byteLength;
  binChunk.set(new Uint8Array(indices.buffer), offset);

  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [0] }],
    nodes: [
      {
        name: 'MeshNode',
        mesh: 0,
        translation: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        children: []
      }
    ],
    meshes: [
      {
        name: 'BenchMesh',
        primitives: [
          {
            attributes: {
              POSITION: 0,
              NORMAL: 1,
              TEXCOORD_0: 2
            },
            indices: 3,
            material: 0
          }
        ]
      }
    ],
    materials: [
      {
        name: 'PbrMat',
        pbrMetallicRoughness: {
          baseColorFactor: [0.5, 0.5, 0.5, 1.0],
          metallicFactor: 0.8,
          roughnessFactor: 0.2
        },
        alphaMode: 'OPAQUE',
        doubleSided: false
      }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: normals.byteLength },
      {
        buffer: 0,
        byteOffset: positions.byteLength + normals.byteLength,
        byteLength: uvs.byteLength
      },
      {
        buffer: 0,
        byteOffset: positions.byteLength + normals.byteLength + uvs.byteLength,
        byteLength: indices.byteLength
      }
    ],
    accessors: [
      {
        bufferView: 0,
        byteOffset: 0,
        componentType: 5126,
        count: vertexCount,
        type: 'VEC3'
      },
      {
        bufferView: 1,
        byteOffset: 0,
        componentType: 5126,
        count: vertexCount,
        type: 'VEC3'
      },
      {
        bufferView: 2,
        byteOffset: 0,
        componentType: 5126,
        count: vertexCount,
        type: 'VEC2'
      },
      {
        bufferView: 3,
        byteOffset: 0,
        componentType: 5123,
        count: indexCount,
        type: 'SCALAR'
      }
    ]
  };

  const jsonString = JSON.stringify(json);
  const jsonBytes = new TextEncoder().encode(jsonString);
  const jsonPadding = (4 - (jsonBytes.byteLength % 4)) % 4;
  const paddedJsonLen = jsonBytes.byteLength + jsonPadding;

  const binLen = binChunk.byteLength;
  const binPadding = (4 - (binLen % 4)) % 4;
  const paddedBinLen = binLen + binPadding;

  const totalLength = 12 + 8 + paddedJsonLen + 8 + paddedBinLen;
  const buffer = new Uint8Array(totalLength);
  const view = new DataView(buffer.buffer);

  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);

  view.setUint32(12, paddedJsonLen, true);
  view.setUint32(16, 0x4e4f534a, true);
  buffer.set(jsonBytes, 20);
  for (let i = 0; i < jsonPadding; i += 1) buffer[20 + jsonBytes.byteLength + i] = 0x20;

  const binHeaderOffset = 20 + paddedJsonLen;
  view.setUint32(binHeaderOffset, paddedBinLen, true);
  view.setUint32(binHeaderOffset + 4, 0x004e4942, true);
  buffer.set(binChunk, binHeaderOffset + 8);

  return buffer;
}

/**
 * Computes a deterministic checksum across canonical mesh attributes.
 */
export function executeGlbIngestBenchmark(glbBytes: Uint8Array): GlbIngestBenchmarkResult {
  const container = parseGlbContainer(glbBytes);
  const bundle = adaptGltfToCanonical(container, { assetPrefix: 'bench' });

  const prim = bundle.meshes[0]!.primitives[0]!;
  const pos = prim.attributes.find((a) => a.semantic === 'position')!;

  let checksum = 0;
  for (let i = 0; i < pos.data.length; i += 1) {
    checksum = (checksum + Math.floor(pos.data[i]! * 100)) & 0x7fffffff;
  }
  if (prim.indices) {
    for (let i = 0; i < prim.indices.data.length; i += 1) {
      checksum = (checksum + prim.indices.data[i]!) & 0x7fffffff;
    }
  }

  return Object.freeze({
    vertexCount: pos.count,
    indexCount: prim.indices?.count ?? 0,
    copiedBytes: bundle.statistics.copiedBytes,
    checksum
  });
}

export function createSyntheticMeshDocument(vertexCount: number): CanonicalMeshDocument {
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);

  for (let i = 0; i < vertexCount; i += 1) {
    positions[i * 3] = (i % 100) * 0.1;
    positions[i * 3 + 1] = Math.floor(i / 100) * 0.1;
    positions[i * 3 + 2] = (i % 7) * 0.05;

    normals[i * 3] = 0;
    normals[i * 3 + 1] = 0;
    normals[i * 3 + 2] = 1;

    uvs[i * 2] = (i % 100) / 100;
    uvs[i * 2 + 1] = Math.floor(i / 100) / 100;
  }

  const indexCount = Math.floor(vertexCount / 3) * 3;
  const indices = new Uint32Array(indexCount);
  for (let i = 0; i < indexCount; i += 1) {
    indices[i] = i;
  }

  return {
    id: `bench.mesh.${vertexCount}` as AssetId,
    kind: 'mesh',
    version: 1,
    primitives: [
      {
        topology: 'triangle-list',
        attributes: [
          {
            semantic: 'position',
            format: 'float32x3',
            count: vertexCount,
            normalized: false,
            data: positions
          },
          {
            semantic: 'normal',
            format: 'float32x3',
            count: vertexCount,
            normalized: false,
            data: normals
          },
          {
            semantic: 'texcoord-0',
            format: 'float32x2',
            count: vertexCount,
            normalized: false,
            data: uvs
          }
        ],
        indices: {
          format: 'u32',
          count: indexCount,
          data: indices
        },
        materialId: null,
        bounds: { min: [0, 0, 0], max: [10, 10, 1] }
      }
    ]
  };
}
