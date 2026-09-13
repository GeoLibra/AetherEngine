import { describe, expect, test } from 'vitest';
import type {
  CanonicalMeshDocument,
  CanonicalMeshPrimitive,
  CanonicalVertexAttribute
} from '../../src/assets/canonical/types';
import type { AssetId } from '../../src/assets/types';
import {
  cookCanonicalMeshDocument,
  cookCanonicalMeshPrimitive
} from '../../src/assets/cooker/mesh-cooker';

describe('mesh cooker', () => {
  function createTestPrimitive(
    options: {
      vertexCount?: number;
      withNormals?: boolean;
      withUv0?: boolean;
      withTangents?: boolean;
      indexFormat?: 'u16' | 'u32';
      indices?: number[];
    } = {}
  ): CanonicalMeshPrimitive {
    const count = options.vertexCount ?? 3;
    const positions = new Float32Array(count * 3);
    // Simple triangle in XY plane
    positions[0] = 0;
    positions[1] = 0;
    positions[2] = 0;
    positions[3] = 1;
    positions[4] = 0;
    positions[5] = 0;
    positions[6] = 0;
    positions[7] = 1;
    positions[8] = 0;

    const attributes: CanonicalVertexAttribute[] = [
      {
        semantic: 'position' as const,
        format: 'float32x3' as const,
        count,
        normalized: false,
        data: positions
      }
    ];

    if (options.withNormals) {
      const normals = new Float32Array(count * 3);
      for (let i = 0; i < count; i += 1) {
        normals[i * 3 + 2] = 1; // +Z
      }
      attributes.push({
        semantic: 'normal' as const,
        format: 'float32x3' as const,
        count,
        normalized: false,
        data: normals
      });
    }

    if (options.withUv0) {
      const uvs = new Float32Array(count * 2);
      uvs[0] = 0;
      uvs[1] = 0;
      uvs[2] = 1;
      uvs[3] = 0;
      uvs[4] = 0;
      uvs[5] = 1;
      attributes.push({
        semantic: 'texcoord-0' as const,
        format: 'float32x2' as const,
        count,
        normalized: false,
        data: uvs
      });
    }

    if (options.withTangents) {
      const tangents = new Float32Array(count * 4);
      for (let i = 0; i < count; i += 1) {
        tangents[i * 4] = 1; // +X
        tangents[i * 4 + 3] = 1; // w = 1
      }
      attributes.push({
        semantic: 'tangent' as const,
        format: 'float32x4' as const,
        count,
        normalized: false,
        data: tangents
      });
    }

    let indicesData = null;
    if (options.indices) {
      const format = options.indexFormat ?? 'u16';
      indicesData = {
        format,
        count: options.indices.length,
        data: format === 'u16' ? new Uint16Array(options.indices) : new Uint32Array(options.indices)
      };
    }

    return {
      topology: 'triangle-list',
      attributes,
      indices: indicesData,
      materialId: 'mat.test' as AssetId,
      bounds: {
        min: [0, 0, 0],
        max: [1, 1, 0]
      }
    };
  }

  test('cooks primitive with complete authored attributes', () => {
    const primitive = createTestPrimitive({
      withNormals: true,
      withUv0: true,
      withTangents: true,
      indices: [0, 1, 2]
    });

    const cooked = cookCanonicalMeshPrimitive(primitive);
    expect(cooked.hasGeneratedTangents).toBe(false);
    expect(cooked.meshData.streams).toHaveLength(5); // pos, normal, uv0, uv1, tangent
    expect(cooked.meshData.vertexCount).toBe(3);
    expect(cooked.cookedIndexFormat).toBe('u16');
  });

  test('generates geometric face normals when normal attribute is absent', () => {
    const primitive = createTestPrimitive({
      withNormals: false,
      withUv0: true,
      indices: [0, 1, 2]
    });

    const cooked = cookCanonicalMeshPrimitive(primitive);
    const normalStream = cooked.meshData.streams.find((s) => s.semantic === 'NORMAL');
    expect(normalStream).toBeDefined();

    const normals = normalStream!.data as Float32Array;
    // For triangle (0,0,0) -> (1,0,0) -> (0,1,0), normal is +Z (0, 0, 1)
    expect(normals[0]).toBeCloseTo(0);
    expect(normals[1]).toBeCloseTo(0);
    expect(normals[2]).toBeCloseTo(1);
  });

  test('zero-fills missing uv0 and uv1', () => {
    const primitive = createTestPrimitive({ withUv0: false });
    const cooked = cookCanonicalMeshPrimitive(primitive);

    const uv0 = cooked.meshData.streams.find((s) => s.semantic === 'TEXCOORD_0');
    const uv1 = cooked.meshData.streams.find((s) => s.semantic === 'TEXCOORD_1');

    expect(uv0).toBeDefined();
    expect(uv1).toBeDefined();
    expect(Array.from(uv0!.data as Float32Array)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(Array.from(uv1!.data as Float32Array)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test('generates MikkTSpace tangents when tangent attribute is missing', () => {
    const primitive = createTestPrimitive({
      withNormals: true,
      withUv0: true,
      withTangents: false,
      indices: [0, 1, 2]
    });

    const cooked = cookCanonicalMeshPrimitive(primitive);
    expect(cooked.hasGeneratedTangents).toBe(true);

    const tangentStream = cooked.meshData.streams.find((s) => s.semantic === 'TANGENT');
    expect(tangentStream).toBeDefined();

    const tangents = tangentStream!.data as Float32Array;
    // UV maps X->U, Y->V, so tangent is +X [1, 0, 0, 1]
    expect(tangents[0]).toBeCloseTo(1);
    expect(tangents[1]).toBeCloseTo(0);
    expect(tangents[2]).toBeCloseTo(0);
    expect(tangents[3]).toBe(1); // handedness
  });

  test('downsamples u32 indices to u16 when vertex count <= 65536', () => {
    const primitive = createTestPrimitive({
      vertexCount: 3,
      indexFormat: 'u32',
      indices: [0, 1, 2]
    });

    const cooked = cookCanonicalMeshPrimitive(primitive);
    expect(cooked.originalIndexFormat).toBe('u32');
    expect(cooked.cookedIndexFormat).toBe('u16');
    expect(cooked.meshData.indices?.format).toBe('u16');
    expect(cooked.meshData.indices?.data).toBeInstanceOf(Uint16Array);
  });

  test('preserves u32 indices when indices contain large values', () => {
    const primitive = createTestPrimitive({
      vertexCount: 70000,
      indexFormat: 'u32',
      indices: [0, 1, 68000]
    });

    const cooked = cookCanonicalMeshPrimitive(primitive);
    expect(cooked.originalIndexFormat).toBe('u32');
    expect(cooked.cookedIndexFormat).toBe('u32');
    expect(cooked.meshData.indices?.format).toBe('u32');
    expect(cooked.meshData.indices?.data).toBeInstanceOf(Uint32Array);
  });

  test('cooks canonical mesh document into artifact', () => {
    const doc: CanonicalMeshDocument = {
      id: 'mesh.doc.1' as AssetId,
      kind: 'mesh',
      version: 1,
      primitives: [createTestPrimitive({ withNormals: true, withUv0: true, indices: [0, 1, 2] })]
    };

    const artifact = cookCanonicalMeshDocument(doc);
    expect(artifact.id).toBe('mesh.doc.1');
    expect(artifact.primitives).toHaveLength(1);
    expect(artifact.totalByteLength).toBeGreaterThan(0);
  });

  test('expands VEC3 float32x3 and unorm8x3 COLOR_0 to 4-component RGBA streams', () => {
    // 1. float32x3
    const primF32: CanonicalMeshPrimitive = {
      ...createTestPrimitive({ vertexCount: 3 }),
      attributes: [
        ...createTestPrimitive({ vertexCount: 3 }).attributes,
        {
          semantic: 'color-0',
          format: 'float32x3',
          count: 3,
          normalized: false,
          data: new Float32Array([1.0, 0.5, 0.25, 0.75, 0.125, 0.375, 0.5, 0.25, 0.125])
        }
      ]
    };
    const cookedF32 = cookCanonicalMeshPrimitive(primF32);
    const colorStreamF32 = cookedF32.meshData.streams.find((s) => s.semantic === 'COLOR_0');
    expect(colorStreamF32).toBeDefined();
    expect(colorStreamF32!.format).toBe('float32x4');
    expect(Array.from(colorStreamF32!.data as Float32Array)).toEqual([
      1.0, 0.5, 0.25, 1.0, 0.75, 0.125, 0.375, 1.0, 0.5, 0.25, 0.125, 1.0
    ]);

    // 2. unorm8x3
    const primU8: CanonicalMeshPrimitive = {
      ...createTestPrimitive({ vertexCount: 3 }),
      attributes: [
        ...createTestPrimitive({ vertexCount: 3 }).attributes,
        {
          semantic: 'color-0',
          format: 'unorm8x3',
          count: 3,
          normalized: true,
          data: new Uint8Array([255, 128, 64, 10, 20, 30, 40, 50, 60])
        }
      ]
    };
    const cookedU8 = cookCanonicalMeshPrimitive(primU8);
    const colorStreamU8 = cookedU8.meshData.streams.find((s) => s.semantic === 'COLOR_0');
    expect(colorStreamU8).toBeDefined();
    expect(colorStreamU8!.format).toBe('unorm8x4');
    expect(Array.from(colorStreamU8!.data as Uint8Array)).toEqual([
      255, 128, 64, 255, 10, 20, 30, 255, 40, 50, 60, 255
    ]);
  });

  test('computes tangents with normalTexture UV1 set and KHR_texture_transform', () => {
    const basePrim = createTestPrimitive({
      withNormals: true,
      withTangents: false,
      indices: [0, 1, 2]
    });
    // Add UV1 attribute
    const uv1Data = new Float32Array([0, 0, 2, 0, 0, 2]);
    const primWithUv1: CanonicalMeshPrimitive = {
      ...basePrim,
      materialId: 'mat.custom' as AssetId,
      attributes: [
        ...basePrim.attributes,
        {
          semantic: 'texcoord-1',
          format: 'float32x2',
          count: 3,
          normalized: false,
          data: uv1Data
        }
      ]
    };

    const material = {
      id: 'mat.custom' as AssetId,
      kind: 'material' as const,
      version: 1,
      alphaMode: 'opaque' as const,
      alphaCutoff: 0.5,
      doubleSided: false,
      baseColorFactor: [1, 1, 1, 1] as const,
      metallicFactor: 1,
      roughnessFactor: 1,
      emissiveFactor: [0, 0, 0] as const,
      baseColorTexture: null,
      metallicRoughnessTexture: null,
      occlusionTexture: null,
      emissiveTexture: null,
      normalTexture: {
        textureId: 'tex.norm' as AssetId,
        samplerId: 'samp.default' as AssetId,
        texCoord: 1 as const, // uses UV1!
        scale: 1,
        transform: {
          scale: [2, 2] as const,
          offset: [0.5, 0.5] as const,
          rotation: 0
        }
      }
    };

    const cooked = cookCanonicalMeshPrimitive(primWithUv1, 0, {
      materials: [material]
    });
    expect(cooked.hasGeneratedTangents).toBe(true);
    const tangentStream = cooked.meshData.streams.find((s) => s.semantic === 'TANGENT');
    expect(tangentStream).toBeDefined();
    const tangents = tangentStream!.data as Float32Array;
    expect(tangents[0]).toBeCloseTo(1);
    expect(tangents[3]).toBe(1);
  });
});
