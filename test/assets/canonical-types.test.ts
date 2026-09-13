import { describe, expect, it } from 'vitest';
import {
  createBounds3,
  computePositionBounds3,
  mergeBounds3,
  createCanonicalIndexData,
  createCanonicalMeshPrimitive,
  createCanonicalStandardPbrMaterial,
  createCanonicalTextureSlot,
  createCanonicalVertexAttribute,
  createCanonicalSceneDocument,
  type CanonicalMeshPrimitive,
  type CanonicalStandardPbrMaterial,
  type CanonicalSceneDocument
} from '../../src/assets/canonical';
import type { AssetId } from '../../src/assets/types';

describe('Canonical Assets Contracts', () => {
  describe('Bounds3', () => {
    it('creates immutable finite bounds and fails if min > max', () => {
      const bounds = createBounds3([-1, -2, -3], [1, 2, 3]);
      expect(bounds.min).toEqual([-1, -2, -3]);
      expect(bounds.max).toEqual([1, 2, 3]);
      expect(Object.isFrozen(bounds)).toBe(true);

      expect(() => createBounds3([2, 0, 0], [1, 0, 0])).toThrow(/min cannot exceed max/);
      expect(() => createBounds3([NaN, 0, 0], [1, 0, 0])).toThrow(/finite/);
    });

    it('computes exact position bounds and merges them', () => {
      const positions = new Float32Array([0, 0, 0, 10, -5, 2, -3, 4, 8]);
      const bounds = computePositionBounds3(positions, 3);
      expect(bounds.min).toEqual([-3, -5, 0]);
      expect(bounds.max).toEqual([10, 4, 8]);

      const other = createBounds3([-10, 0, 0], [5, 10, 10]);
      const merged = mergeBounds3(bounds, other);
      expect(merged.min).toEqual([-10, -5, 0]);
      expect(merged.max).toEqual([10, 10, 10]);
    });
  });

  describe('Vertex Attribute and Index Data', () => {
    it('defensively copies caller-owned buffers', () => {
      const callerBuffer = new Float32Array([1, 2, 3, 4, 5, 6]);
      const attr = createCanonicalVertexAttribute({
        semantic: 'position',
        format: 'float32x3',
        count: 2,
        normalized: false,
        data: callerBuffer
      });

      // Caller mutates their own buffer
      callerBuffer[0] = 999;
      // Internal canonical data must remain unchanged
      expect(attr.data[0]).toBe(1);
    });

    it('fails on invalid semantics or non-positive count', () => {
      expect(() =>
        createCanonicalVertexAttribute({
          semantic: 'invalid-semantic' as any,
          format: 'float32',
          count: 1,
          normalized: false,
          data: new Float32Array([1])
        })
      ).toThrow(/Unsupported canonical vertex semantic/);

      expect(() =>
        createCanonicalVertexAttribute({
          semantic: 'position',
          format: 'float32',
          count: 0,
          normalized: false,
          data: new Float32Array([])
        })
      ).toThrow(/positive integer/);
    });

    it('validates index format and copies caller indices', () => {
      const callerIndices = new Uint16Array([0, 1, 2]);
      const indices = createCanonicalIndexData({
        format: 'u16',
        count: 3,
        data: callerIndices
      });
      callerIndices[0] = 99;
      expect(indices.data[0]).toBe(0);
    });
  });

  describe('Mesh Primitive', () => {
    it('validates vertex counts across attributes and indices within bounds', () => {
      const primitive: CanonicalMeshPrimitive = {
        topology: 'triangle-list',
        attributes: [
          {
            semantic: 'position',
            format: 'float32x3',
            count: 3,
            normalized: false,
            data: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
          },
          {
            semantic: 'normal',
            format: 'float32x3',
            count: 3,
            normalized: false,
            data: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])
          }
        ],
        indices: {
          format: 'u16',
          count: 3,
          data: new Uint16Array([0, 1, 2])
        },
        materialId: 'mat-1' as AssetId,
        bounds: createBounds3([0, 0, 0], [1, 1, 0])
      };

      const validated = createCanonicalMeshPrimitive(primitive);
      expect(validated.attributes.length).toBe(2);
      expect(validated.indices?.count).toBe(3);

      // Fails when index exceeds vertex count
      expect(() =>
        createCanonicalMeshPrimitive({
          ...primitive,
          indices: {
            format: 'u16',
            count: 3,
            data: new Uint16Array([0, 1, 5])
          }
        })
      ).toThrow(/exceeds vertex count/);
    });
  });

  describe('Texture Slot and Material', () => {
    it('restricts UV set to 0 or 1', () => {
      const validSlot = createCanonicalTextureSlot({
        textureId: 'tex-1' as AssetId,
        samplerId: 'smp-1' as AssetId,
        texCoord: 0,
        transform: { offset: [0, 0], scale: [1, 1], rotation: 0 }
      });
      expect(validSlot.texCoord).toBe(0);

      expect(() =>
        createCanonicalTextureSlot({
          textureId: 'tex-1' as AssetId,
          samplerId: 'smp-1' as AssetId,
          texCoord: 2 as any,
          transform: { offset: [0, 0], scale: [1, 1], rotation: 0 }
        })
      ).toThrow(/texCoord must be 0 or 1/);
    });

    it('validates PBR material factors within range and enforces alpha modes', () => {
      const material: CanonicalStandardPbrMaterial = {
        id: 'mat-pbr-1' as AssetId,
        kind: 'material',
        version: 1,
        baseColorFactor: [1, 1, 1, 1],
        baseColorTexture: null,
        metallicFactor: 0.5,
        roughnessFactor: 0.2,
        metallicRoughnessTexture: null,
        normalTexture: null,
        occlusionTexture: null,
        emissiveFactor: [0, 0, 0],
        emissiveTexture: null,
        alphaMode: 'opaque',
        alphaCutoff: 0.5,
        doubleSided: false
      };

      const validated = createCanonicalStandardPbrMaterial(material);
      expect(validated.metallicFactor).toBe(0.5);

      // Fails on out of range metallic
      expect(() =>
        createCanonicalStandardPbrMaterial({
          ...material,
          metallicFactor: 1.5
        })
      ).toThrow(/range/);

      // Fails on invalid alpha mode
      expect(() =>
        createCanonicalStandardPbrMaterial({
          ...material,
          alphaMode: 'translucent' as any
        })
      ).toThrow(/Unsupported material alphaMode/);
    });
  });

  describe('Scene Hierarchy', () => {
    it('detects self-referencing cycles and out of bounds node children', () => {
      const scene: CanonicalSceneDocument = {
        id: 'scene-1' as AssetId,
        kind: 'scene',
        version: 1,
        nodes: [
          {
            name: 'Root',
            transform: {
              kind: 'trs',
              translation: [0, 0, 0],
              rotation: [0, 0, 0, 1],
              scale: [1, 1, 1]
            },
            children: [0]
          }
        ],
        rootNodes: [0]
      };

      expect(() => createCanonicalSceneDocument(scene)).toThrow(/directly references itself/);

      expect(() =>
        createCanonicalSceneDocument({
          ...scene,
          nodes: [
            {
              name: 'Root',
              transform: {
                kind: 'trs',
                translation: [0, 0, 0],
                rotation: [0, 0, 0, 1],
                scale: [1, 1, 1]
              },
              children: [99]
            }
          ]
        })
      ).toThrow(/out-of-bounds child index/);
    });
  });
});
