import { describe, expect, test } from 'vitest';
import type { AssetId } from '../../src/assets/types';
import type { CanonicalStandardPbrMaterial } from '../../src/assets/canonical/types';
import {
  canonicalMaterialToStandardLitOptions,
  computeStandardPbrFeatureKey,
  cookCanonicalMaterial
} from '../../src/assets/cooker/material-cooker';
import { composeTextureUvTransform } from '../../src/assets/canonical';
import { BUILTIN_TEXTURE_IDS } from '../../src/assets/cooker/texture-cooker';

describe('material cooker', () => {
  function createTestMaterial(
    partial: Partial<CanonicalStandardPbrMaterial> = {}
  ): CanonicalStandardPbrMaterial {
    return {
      id: 'mat.test.1' as AssetId,
      kind: 'material',
      version: 1,
      baseColorFactor: [0.8, 0.8, 0.8, 1.0],
      baseColorTexture: null,
      metallicFactor: 0.5,
      roughnessFactor: 0.25,
      metallicRoughnessTexture: null,
      normalTexture: null,
      occlusionTexture: null,
      emissiveFactor: [0, 0, 0],
      emissiveTexture: null,
      alphaMode: 'opaque',
      alphaCutoff: 0.5,
      doubleSided: false,
      ...partial
    };
  }

  test('computes feature key correctly for untextured opaque material', () => {
    const mat = createTestMaterial();
    const key = computeStandardPbrFeatureKey(mat);

    expect(key.baseColorTexture).toBe(false);
    expect(key.metallicRoughnessTexture).toBe(false);
    expect(key.normalTexture).toBe(false);
    expect(key.occlusionTexture).toBe(false);
    expect(key.emissiveTexture).toBe(false);
    expect(key.alphaMode).toBe('opaque');
    expect(key.doubleSided).toBe(false);
    expect(key.uvMask).toBe(0);
  });

  test('computes feature key with textures and uv mask', () => {
    const mat = createTestMaterial({
      baseColorTexture: {
        textureId: 'tex.bc' as AssetId,
        samplerId: 'samp.default' as AssetId,
        texCoord: 0,
        transform: { offset: [0, 0], scale: [1, 1], rotation: 0 }
      },
      normalTexture: {
        textureId: 'tex.norm' as AssetId,
        samplerId: 'samp.default' as AssetId,
        texCoord: 1,
        transform: { offset: [0, 0], scale: [1, 1], rotation: 0 },
        scale: 1
      },
      alphaMode: 'mask',
      doubleSided: true
    });

    const key = computeStandardPbrFeatureKey(mat, true);
    expect(key.baseColorTexture).toBe(true);
    expect(key.normalTexture).toBe(true);
    expect(key.vertexColor).toBe(true);
    expect(key.alphaMode).toBe('mask');
    expect(key.doubleSided).toBe(true);
    // normalTexture is texCoord 1 -> bit 2 (1 << 2 = 4)
    expect(key.uvMask).toBe(4);
  });

  test('converts canonical material to standard lit options with fallbacks', () => {
    const mat = createTestMaterial();
    const options = canonicalMaterialToStandardLitOptions(mat);

    expect(options.baseColor).toEqual([0.8, 0.8, 0.8, 1.0]);
    expect(options.metallic).toBe(0.5);
    expect(options.roughness).toBe(0.25);
    expect(options.baseColorTexture?.assetId).toBe(BUILTIN_TEXTURE_IDS.WhiteSrgb);
    expect(options.metallicRoughnessTexture?.assetId).toBe(BUILTIN_TEXTURE_IDS.WhiteData);
    expect(options.normalTexture?.assetId).toBe(BUILTIN_TEXTURE_IDS.FlatNormal);
    expect(options.emissiveTexture?.assetId).toBe(BUILTIN_TEXTURE_IDS.BlackSrgb);
  });

  test('cooks canonical material into runtime StandardLitMaterial bundle', () => {
    const mat = createTestMaterial({
      metallicFactor: 1.0,
      roughnessFactor: 0.1
    });

    const bundle = cookCanonicalMaterial(mat);
    expect(bundle.asset).toBeDefined();
    expect(bundle.resolved).toBeDefined();
    expect(bundle.instance).toBeDefined();
    expect(bundle.asset.id).toBe('aether.material.standard-lit');
  });

  test('cooks texture transforms and blend alpha mode with double sided cullMode', () => {
    const mat = createTestMaterial({
      baseColorTexture: {
        textureId: 'tex.bc' as AssetId,
        samplerId: 'samp.default' as AssetId,
        texCoord: 0,
        transform: {
          offset: [0.1, 0.2],
          scale: [2, 3],
          rotation: Math.PI / 4
        }
      },
      alphaMode: 'blend',
      doubleSided: true
    });

    const options = canonicalMaterialToStandardLitOptions(mat);
    expect(options.alphaMode).toBe('blend');
    expect(options.doubleSided).toBe(true);
    expect(options.transforms?.baseColor).toEqual(
      composeTextureUvTransform({
        offset: [0.1, 0.2],
        scale: [2, 3],
        rotation: Math.PI / 4
      })
    );

    const bundle = cookCanonicalMaterial(mat);
    expect(bundle.asset.renderState.cullMode).toBe('none');
    expect(bundle.asset.renderState.depthWrite).toBe(false);
    expect(bundle.asset.renderState.surface).toBe('transparent');
  });

  test('accepts structurally equivalent samplers across slots with different IDs', () => {
    const samplers = [
      {
        id: 'samp.0' as AssetId,
        kind: 'sampler' as const,
        version: 1,
        magFilter: 'linear' as const,
        minFilter: 'linear' as const,
        wrapS: 'repeat' as const,
        wrapT: 'repeat' as const
      },
      {
        id: 'samp.default' as AssetId,
        kind: 'sampler' as const,
        version: 1,
        magFilter: 'linear' as const,
        minFilter: 'linear' as const,
        wrapS: 'repeat' as const,
        wrapT: 'repeat' as const
      }
    ];

    const mat = createTestMaterial({
      baseColorTexture: {
        textureId: 'tex.bc' as AssetId,
        samplerId: 'samp.0' as AssetId,
        texCoord: 0,
        transform: { offset: [0, 0], scale: [1, 1], rotation: 0 }
      },
      normalTexture: {
        textureId: 'tex.norm' as AssetId,
        samplerId: 'samp.default' as AssetId,
        texCoord: 0,
        scale: 1,
        transform: { offset: [0, 0], scale: [1, 1], rotation: 0 }
      }
    });

    const options = canonicalMaterialToStandardLitOptions(mat, { samplers });
    expect(options.sampler?.assetId).toBe('samp.0');
    expect(options.samplers?.baseColor?.assetId).toBe('samp.0');
    expect(options.samplers?.normal?.assetId).toBe('samp.default');
  });

  test('accepts heterogeneous samplers across slots and records them in options.samplers', () => {
    const samplers = [
      {
        id: 'samp.repeat' as AssetId,
        kind: 'sampler' as const,
        version: 1,
        magFilter: 'linear' as const,
        minFilter: 'linear' as const,
        wrapS: 'repeat' as const,
        wrapT: 'repeat' as const
      },
      {
        id: 'samp.clamp' as AssetId,
        kind: 'sampler' as const,
        version: 1,
        magFilter: 'nearest' as const,
        minFilter: 'nearest' as const,
        wrapS: 'clamp-to-edge' as const,
        wrapT: 'clamp-to-edge' as const
      }
    ];

    const mat = createTestMaterial({
      baseColorTexture: {
        textureId: 'tex.bc' as AssetId,
        samplerId: 'samp.repeat' as AssetId,
        texCoord: 0,
        transform: { offset: [0, 0], scale: [1, 1], rotation: 0 }
      },
      normalTexture: {
        textureId: 'tex.norm' as AssetId,
        samplerId: 'samp.clamp' as AssetId,
        texCoord: 0,
        scale: 1,
        transform: { offset: [0, 0], scale: [1, 1], rotation: 0 }
      }
    });

    const options = canonicalMaterialToStandardLitOptions(mat, { samplers });
    expect(options.samplers?.baseColor?.assetId).toBe('samp.repeat');
    expect(options.samplers?.normal?.assetId).toBe('samp.clamp');
    expect(options.sampler?.assetId).toBe('samp.repeat');
    expect(options.baseColorTexture?.assetId).toBe('tex.bc:base-color');
    expect(options.normalTexture?.assetId).toBe('tex.norm:normal');
  });
});
