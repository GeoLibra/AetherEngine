import { describe, expect, test } from 'vitest';
import type { AssetId } from '../../src/assets/types';
import type {
  CanonicalMeshPrimitive,
  CanonicalStandardPbrMaterial
} from '../../src/assets/canonical/types';
import { cookCanonicalMeshPrimitive } from '../../src/assets/cooker/mesh-cooker';
import { transformAuthoredTangents } from '../../src/assets/cooker/mesh-geometry-utils';

describe('mesh tangents and UV validation', () => {
  test('transforms authored tangents under normal texture rotation and reflection', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const uv0 = new Float32Array([0, 0, 1, 0, 0, 1]);
    // Authored tangent pointing along +X with right-handed orientation (+1)
    const authoredTangents = new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);

    const primitive: CanonicalMeshPrimitive = {
      topology: 'triangle-list',
      indices: null,
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      materialId: 'mat.transformed' as AssetId,
      attributes: [
        { semantic: 'position', format: 'float32x3', count: 3, normalized: false, data: positions },
        { semantic: 'normal', format: 'float32x3', count: 3, normalized: false, data: normals },
        { semantic: 'texcoord-0', format: 'float32x2', count: 3, normalized: false, data: uv0 },
        {
          semantic: 'tangent',
          format: 'float32x4',
          count: 3,
          normalized: false,
          data: authoredTangents
        }
      ]
    };

    // 90-degree counterclockwise rotation with horizontal reflection (scale: [-1, 1])
    const material: CanonicalStandardPbrMaterial = {
      id: 'mat.transformed' as AssetId,
      kind: 'material',
      version: 1,
      alphaMode: 'opaque',
      alphaCutoff: 0.5,
      doubleSided: false,
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: 0,
      roughnessFactor: 0.5,
      emissiveFactor: [0, 0, 0],
      baseColorTexture: null,
      metallicRoughnessTexture: null,
      occlusionTexture: null,
      emissiveTexture: null,
      normalTexture: {
        textureId: 'tex.norm' as AssetId,
        samplerId: 'samp.default' as AssetId,
        texCoord: 0,
        scale: 1,
        transform: {
          rotation: Math.PI / 2,
          scale: [-1, 1],
          offset: [0, 0]
        }
      }
    };

    const cooked = cookCanonicalMeshPrimitive(primitive, 0, { materials: [material] });
    expect(cooked.hasGeneratedTangents).toBe(false); // Authored tangent preserved & transformed
    const stream = cooked.meshData.streams.find((s) => s.semantic === 'TANGENT')!;
    const t = stream.data as Float32Array;
    // Under 90 deg rotation & horizontal reflection, handedness flips: W' = 1 * (-1) = -1
    expect(t[3]).toBe(-1);
  });

  test('transformAuthoredTangents returns identical array when no rotation or reflection', () => {
    const normals = new Float32Array([0, 0, 1]);
    const tangents = new Float32Array([1, 0, 0, 1]);
    const transformed = transformAuthoredTangents(tangents, normals, 1, {
      rotation: 0,
      scale: [1, 1],
      offset: [0, 0]
    });
    expect(transformed).toBe(tangents);
  });

  test('generates tangents from UV1 when normalTexture uses texCoord 1 even if authored tangents exist', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const uv0 = new Float32Array([0, 0, 1, 0, 0, 1]);
    const uv1 = new Float32Array([0, 0, 0, 1, 1, 0]);
    const authoredTangents = new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);

    const primitive: CanonicalMeshPrimitive = {
      topology: 'triangle-list',
      indices: null,
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      materialId: 'mat.uv1-norm' as AssetId,
      attributes: [
        { semantic: 'position', format: 'float32x3', count: 3, normalized: false, data: positions },
        { semantic: 'normal', format: 'float32x3', count: 3, normalized: false, data: normals },
        { semantic: 'texcoord-0', format: 'float32x2', count: 3, normalized: false, data: uv0 },
        { semantic: 'texcoord-1', format: 'float32x2', count: 3, normalized: false, data: uv1 },
        {
          semantic: 'tangent',
          format: 'float32x4',
          count: 3,
          normalized: false,
          data: authoredTangents
        }
      ]
    };

    const material: CanonicalStandardPbrMaterial = {
      id: 'mat.uv1-norm' as AssetId,
      kind: 'material',
      version: 1,
      alphaMode: 'opaque',
      alphaCutoff: 0.5,
      doubleSided: false,
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: 0,
      roughnessFactor: 0.5,
      emissiveFactor: [0, 0, 0],
      baseColorTexture: null,
      metallicRoughnessTexture: null,
      occlusionTexture: null,
      emissiveTexture: null,
      normalTexture: {
        textureId: 'tex.norm' as AssetId,
        samplerId: 'samp.default' as AssetId,
        texCoord: 1, // uses UV1!
        scale: 1,
        transform: {
          scale: [1, 1],
          offset: [0, 0],
          rotation: 0
        }
      }
    };

    const cooked = cookCanonicalMeshPrimitive(primitive, 0, { materials: [material] });
    expect(cooked.hasGeneratedTangents).toBe(true); // Generated from UV1
  });

  test('fails fast when material references UV0 missing from primitive', () => {
    const primitive: CanonicalMeshPrimitive = {
      topology: 'triangle-list',
      indices: null,
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      materialId: 'mat.requires-uv0' as AssetId,
      attributes: [
        {
          semantic: 'position',
          format: 'float32x3',
          count: 3,
          normalized: false,
          data: new Float32Array(9)
        },
        {
          semantic: 'normal',
          format: 'float32x3',
          count: 3,
          normalized: false,
          data: new Float32Array(9)
        }
      ]
    };

    const material: CanonicalStandardPbrMaterial = {
      id: 'mat.requires-uv0' as AssetId,
      kind: 'material',
      version: 1,
      alphaMode: 'opaque',
      alphaCutoff: 0.5,
      doubleSided: false,
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: 0,
      roughnessFactor: 0.5,
      emissiveFactor: [0, 0, 0],
      baseColorTexture: {
        textureId: 'tex.bc' as AssetId,
        samplerId: 'samp.default' as AssetId,
        texCoord: 0,
        transform: { offset: [0, 0], scale: [1, 1], rotation: 0 }
      },
      metallicRoughnessTexture: null,
      occlusionTexture: null,
      emissiveTexture: null,
      normalTexture: null
    };

    expect(() => cookCanonicalMeshPrimitive(primitive, 0, { materials: [material] })).toThrowError(
      /gltf-render\.missing-uv-set/
    );
  });

  test('fails fast when material references UV1 missing from primitive', () => {
    const primitive: CanonicalMeshPrimitive = {
      topology: 'triangle-list',
      indices: null,
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      materialId: 'mat.requires-uv1' as AssetId,
      attributes: [
        {
          semantic: 'position',
          format: 'float32x3',
          count: 3,
          normalized: false,
          data: new Float32Array(9)
        },
        {
          semantic: 'normal',
          format: 'float32x3',
          count: 3,
          normalized: false,
          data: new Float32Array(9)
        },
        {
          semantic: 'texcoord-0',
          format: 'float32x2',
          count: 3,
          normalized: false,
          data: new Float32Array(6)
        }
      ]
    };

    const material: CanonicalStandardPbrMaterial = {
      id: 'mat.requires-uv1' as AssetId,
      kind: 'material',
      version: 1,
      alphaMode: 'opaque',
      alphaCutoff: 0.5,
      doubleSided: false,
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: 0,
      roughnessFactor: 0.5,
      emissiveFactor: [0, 0, 0],
      baseColorTexture: null,
      metallicRoughnessTexture: null,
      occlusionTexture: {
        textureId: 'tex.ao' as AssetId,
        samplerId: 'samp.default' as AssetId,
        texCoord: 1,
        strength: 1,
        transform: { offset: [0, 0], scale: [1, 1], rotation: 0 }
      },
      emissiveTexture: null,
      normalTexture: null
    };

    expect(() => cookCanonicalMeshPrimitive(primitive, 0, { materials: [material] })).toThrowError(
      /gltf-render\.missing-uv-set/
    );
  });
});
