import { describe, expect, it } from 'vitest';
import {
  GltfImporter,
  parseGlbContainer,
  adaptGltfToCanonical
} from '../../src/assets/importers/gltf';
import { InMemoryDiagnosticSink } from '../../src/assets/importer/diagnostics';
import { StandardImportBudget } from '../../src/assets/importer/budget';
import type { AssetImportContext, AssetDependencyResolver } from '../../src/assets/importer/types';
import { VirtualFileSystem } from '../../src/assets/vfs';

/** Helper to build a valid GLB binary in memory. */
function buildGlb(json: Record<string, any>, binaryChunk?: Uint8Array): Uint8Array {
  const jsonString = JSON.stringify(json);
  const jsonBytes = new TextEncoder().encode(jsonString);
  const jsonPadding = (4 - (jsonBytes.byteLength % 4)) % 4;
  const paddedJsonLen = jsonBytes.byteLength + jsonPadding;

  const binLen = binaryChunk ? binaryChunk.byteLength : 0;
  const binPadding = binaryChunk ? (4 - (binLen % 4)) % 4 : 0;
  const paddedBinLen = binLen + binPadding;

  const totalLength = 12 + 8 + paddedJsonLen + (binaryChunk ? 8 + paddedBinLen : 0);
  const buffer = new Uint8Array(totalLength);
  const view = new DataView(buffer.buffer);

  // 12-byte header
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true); // version 2
  view.setUint32(8, totalLength, true);

  // JSON chunk header
  view.setUint32(12, paddedJsonLen, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  buffer.set(jsonBytes, 20);
  for (let i = 0; i < jsonPadding; i += 1) {
    buffer[20 + jsonBytes.byteLength + i] = 0x20; // space padding
  }

  // BIN chunk header
  if (binaryChunk) {
    const binHeaderOffset = 20 + paddedJsonLen;
    view.setUint32(binHeaderOffset, paddedBinLen, true);
    view.setUint32(binHeaderOffset + 4, 0x004e4942, true); // 'BIN\0'
    buffer.set(binaryChunk, binHeaderOffset + 8);
    for (let i = 0; i < binPadding; i += 1) {
      buffer[binHeaderOffset + 8 + binLen + i] = 0x00; // null padding
    }
  }

  return buffer;
}

function createMockContext(
  overrides: {
    budget?: StandardImportBudget;
    signal?: AbortSignal;
    dependencies?: Partial<AssetDependencyResolver>;
  } = {}
): AssetImportContext {
  const diagnostics = new InMemoryDiagnosticSink();
  const budget = overrides.budget ?? new StandardImportBudget();
  const controller = new AbortController();
  const signal = overrides.signal ?? controller.signal;
  const vfs = new VirtualFileSystem();

  const dependencies: AssetDependencyResolver = {
    resolve: (parent, rel) => overrides.dependencies?.resolve?.(parent, rel) ?? `${parent}/${rel}`,
    load: async (uri, sig) => {
      if (overrides.dependencies?.load) return overrides.dependencies.load(uri, sig);
      throw new Error(`Dependency not found: ${uri}`);
    }
  };

  return { vfs, signal, budget, diagnostics, dependencies };
}

describe('GltfImporter & GLB Ingestion', () => {
  it('probes GLB magic bytes with high confidence', async () => {
    const importer = new GltfImporter();
    const glb = buildGlb({ asset: { version: '2.0' } });
    const probeRes = await importer.probe(
      {
        uri: 'model.glb',
        headerBytes: glb.slice(0, 16)
      },
      { signal: new AbortController().signal }
    );

    expect(probeRes.match).toBe(true);
    if (probeRes.match) {
      expect(probeRes.confidence).toBe(1.0);
      expect(probeRes.estimatedKind).toBe('scene');
    }
  });

  it('imports a complete valid GLB model into Canonical documents', async () => {
    // 3 vertices for a triangle: positions (3x3 float), normals (3x3 float), uv0 (3x2 float), indices (3 u16)
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const uv0 = new Float32Array([0, 0, 1, 0, 0, 1]);
    const indices = new Uint16Array([0, 1, 2]);

    const binSize = positions.byteLength + normals.byteLength + uv0.byteLength + indices.byteLength;
    const binChunk = new Uint8Array(binSize);
    let offset = 0;
    binChunk.set(new Uint8Array(positions.buffer), offset);
    offset += positions.byteLength;
    binChunk.set(new Uint8Array(normals.buffer), offset);
    offset += normals.byteLength;
    binChunk.set(new Uint8Array(uv0.buffer), offset);
    offset += uv0.byteLength;
    binChunk.set(new Uint8Array(indices.buffer), offset);

    const json = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ name: 'DefaultScene', nodes: [0] }],
      nodes: [
        {
          name: 'MeshNode',
          mesh: 0,
          translation: [1, 2, 3],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
          children: []
        }
      ],
      meshes: [
        {
          name: 'TriangleMesh',
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
          name: 'PbrMaterial',
          pbrMetallicRoughness: {
            baseColorFactor: [0.8, 0.2, 0.2, 1.0],
            metallicFactor: 0.9,
            roughnessFactor: 0.1
          },
          alphaMode: 'MASK',
          alphaCutoff: 0.4,
          doubleSided: true
        }
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 36 },
        { buffer: 0, byteOffset: 72, byteLength: 24 },
        { buffer: 0, byteOffset: 96, byteLength: 6 }
      ],
      accessors: [
        {
          bufferView: 0,
          byteOffset: 0,
          componentType: 5126, // FLOAT
          count: 3,
          type: 'VEC3',
          min: [0, 0, 0],
          max: [1, 1, 0]
        },
        {
          bufferView: 1,
          byteOffset: 0,
          componentType: 5126,
          count: 3,
          type: 'VEC3'
        },
        {
          bufferView: 2,
          byteOffset: 0,
          componentType: 5126,
          count: 3,
          type: 'VEC2'
        },
        {
          bufferView: 3,
          byteOffset: 0,
          componentType: 5123, // UNSIGNED_SHORT
          count: 3,
          type: 'SCALAR'
        }
      ]
    };

    const glbData = buildGlb(json, binChunk);
    const importer = new GltfImporter();
    const context = createMockContext();

    const result = await importer.import(
      {
        uri: 'triangle.glb',
        kind: 'buffer',
        buffer: glbData
      },
      context
    );

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      const scene = result.document;
      expect(scene.kind).toBe('scene');
      expect(scene.nodes.length).toBe(1);
      const node = scene.nodes[0]!;
      expect(node.name).toBe('MeshNode');
      expect(node.transform.kind).toBe('trs');
      if (node.transform.kind === 'trs') {
        expect(node.transform.translation).toEqual([1, 2, 3]);
      }

      // Verify raw container adaptation
      const rawContainer = parseGlbContainer(glbData);
      const bundle = adaptGltfToCanonical(rawContainer, { assetPrefix: 'triangle' });
      expect(bundle.meshes.length).toBe(1);
      const mesh = bundle.meshes[0]!;
      expect(mesh.primitives.length).toBe(1);
      const prim = mesh.primitives[0]!;
      expect(prim.attributes.length).toBe(3);
      expect(prim.indices?.count).toBe(3);
      expect(prim.bounds.min).toEqual([0, 0, 0]);
      expect(prim.bounds.max).toEqual([1, 1, 0]);

      // Verify material
      expect(bundle.materials.length).toBe(1);
      const mat = bundle.materials[0]!;
      expect(mat.alphaMode).toBe('mask');
      expect(mat.alphaCutoff).toBe(0.4);
      expect(mat.doubleSided).toBe(true);
      expect(mat.metallicFactor).toBe(0.9);
      expect(mat.roughnessFactor).toBe(0.1);
      expect(mat.baseColorFactor).toEqual([0.8, 0.2, 0.2, 1.0]);

      // Verify statistics
      expect(result.statistics.readBytes).toBeGreaterThanOrEqual(binSize);
      expect(result.statistics.documentCount).toBeGreaterThan(0);
    }
  });

  it('fails fast on unsupported required extensions', async () => {
    const json = {
      asset: { version: '2.0' },
      extensionsRequired: ['KHR_draco_mesh_compression', 'KHR_materials_volume'],
      scenes: [{ nodes: [] }]
    };
    const glbData = buildGlb(json);
    const importer = new GltfImporter();
    const context = createMockContext();

    const result = await importer.import(
      {
        uri: 'model-draco.glb',
        kind: 'buffer',
        buffer: glbData
      },
      context
    );

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.failure.code).toBe('unsupported-required-extension');
      expect(result.failure.message).toContain('KHR_draco_mesh_compression');
    }
  });

  it('handles cancellation gracefully via AbortSignal', async () => {
    const glbData = buildGlb({ asset: { version: '2.0' }, scenes: [{ nodes: [] }] });
    const importer = new GltfImporter();
    const controller = new AbortController();
    controller.abort(); // already cancelled

    const context = createMockContext({ signal: controller.signal });
    const result = await importer.import(
      {
        uri: 'cancelled.glb',
        kind: 'buffer',
        buffer: glbData
      },
      context
    );

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.failure.code).toBe('cancelled');
    }
  });

  it('fails on corrupted magic signature', async () => {
    const invalidGlb = new Uint8Array([
      0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00
    ]);
    const importer = new GltfImporter();
    const context = createMockContext();

    const result = await importer.import(
      {
        uri: 'corrupt.glb',
        kind: 'buffer',
        buffer: invalidGlb
      },
      context
    );

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.failure.code).toBe('invalid-magic');
    }
  });

  it('enforces budget limits during import', async () => {
    const json = { asset: { version: '2.0' }, scenes: [{ nodes: [] }] };
    const bigBin = new Uint8Array(1024 * 1024); // 1 MB
    const glbData = buildGlb(json, bigBin);

    const importer = new GltfImporter();
    // Set budget limit to 100 KB
    const budget = new StandardImportBudget({ maxSizeBytes: 100 * 1024 });
    const context = createMockContext({ budget });

    const result = await importer.import(
      {
        uri: 'oversize.glb',
        kind: 'buffer',
        buffer: glbData
      },
      context
    );

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.failure.code).toBe('size-limit-exceeded');
    }
  });
});
