import { describe, expect, test, vi } from 'vitest';
import type { AssetId } from '../../src/assets/types';
import type {
  CanonicalSamplerDocument,
  CanonicalTextureDocument
} from '../../src/assets/canonical/types';
import {
  BUILTIN_TEXTURE_IDS,
  cookCanonicalSampler,
  cookCanonicalTexture,
  createDefaultBlackSrgbTexture,
  createDefaultFlatNormalTexture,
  createDefaultWhiteDataTexture,
  createDefaultWhiteSrgbTexture,
  getCookedTextureId,
  getRoleProperties
} from '../../src/assets/cooker/texture-cooker';
import { CookedTextureRegistry } from '../../src/assets/cooker/cooked-texture-registry';
import type { RHIDevice, RHISampler, RHITexture } from '../../src/rhi/contracts';

describe('texture cooker and registry', () => {
  test('maps role to shader semantic and color space format', () => {
    expect(getRoleProperties('base-color')).toEqual({
      semantic: 'color',
      format: 'rgba8unorm-srgb'
    });
    expect(getRoleProperties('metallic-roughness')).toEqual({
      semantic: 'data',
      format: 'rgba8unorm'
    });
    expect(getRoleProperties('normal')).toEqual({
      semantic: 'normal',
      format: 'rgba8unorm'
    });
    expect(getRoleProperties('occlusion')).toEqual({
      semantic: 'data',
      format: 'rgba8unorm'
    });
    expect(getRoleProperties('emissive')).toEqual({
      semantic: 'color',
      format: 'rgba8unorm-srgb'
    });
  });

  test('rejects unready or undecoded textures with descriptive error', () => {
    const emptyDoc: CanonicalTextureDocument = {
      id: 'tex.empty' as AssetId,
      kind: 'texture',
      version: 1
    };
    expect(() => cookCanonicalTexture(emptyDoc, 'base-color')).toThrowError(
      /Cannot cook texture "tex.empty"/
    );

    const uriOnlyDoc: CanonicalTextureDocument = {
      id: 'tex.uri' as AssetId,
      kind: 'texture',
      version: 1,
      uri: 'textures/diffuse.png'
    };
    expect(() => cookCanonicalTexture(uriOnlyDoc, 'base-color')).toThrowError(
      /texture is not ready or has not been decoded/
    );

    const compressedDoc: CanonicalTextureDocument = {
      id: 'tex.compressed' as AssetId,
      kind: 'texture',
      version: 1,
      width: 2,
      height: 2,
      data: new Uint8Array([1, 2, 3]), // 3 bytes instead of 2x2x4 = 16 bytes
      mimeType: 'image/png'
    };
    expect(() => cookCanonicalTexture(compressedDoc, 'base-color')).toThrowError(
      /has not been decoded to uncompressed RGBA8 pixels/
    );
  });

  test('cooks fully decoded uncompressed RGBA8 texture', () => {
    const decodedDoc: CanonicalTextureDocument = {
      id: 'tex.ready' as AssetId,
      kind: 'texture',
      version: 1,
      width: 1,
      height: 1,
      data: new Uint8Array([200, 100, 50, 255])
    };

    const cooked = cookCanonicalTexture(decodedDoc, 'base-color');
    expect(cooked.id).toBe(getCookedTextureId('tex.ready', 'base-color'));
    expect(cooked.format).toBe('rgba8unorm-srgb');
    expect(cooked.semantic).toBe('color');
    expect(cooked.width).toBe(1);
    expect(cooked.height).toBe(1);
    expect(Array.from(cooked.data)).toEqual([200, 100, 50, 255]);
  });

  test('normalizes uncompressed normal map data', () => {
    // A non-unit normal [200, 200, 200, 255]
    const rawData = new Uint8Array([200, 200, 200, 255]);
    const doc: CanonicalTextureDocument = {
      id: 'tex.norm' as AssetId,
      kind: 'texture',
      version: 1,
      width: 1,
      height: 1,
      data: rawData
    };

    const cooked = cookCanonicalTexture(doc, 'normal');
    expect(cooked.semantic).toBe('normal');
    // Normalized normal vector components should be unit length
    const nx = (cooked.data[0]! / 255.0) * 2.0 - 1.0;
    const ny = (cooked.data[1]! / 255.0) * 2.0 - 1.0;
    const nz = (cooked.data[2]! / 255.0) * 2.0 - 1.0;
    const len = Math.hypot(nx, ny, nz);
    expect(len).toBeCloseTo(1.0, 2);
  });

  test('creates built-in default texture artifacts', () => {
    const whiteSrgb = createDefaultWhiteSrgbTexture();
    expect(whiteSrgb.id).toBe(BUILTIN_TEXTURE_IDS.WhiteSrgb);
    expect(whiteSrgb.semantic).toBe('color');

    const whiteData = createDefaultWhiteDataTexture();
    expect(whiteData.id).toBe(BUILTIN_TEXTURE_IDS.WhiteData);
    expect(whiteData.semantic).toBe('data');

    const flatNormal = createDefaultFlatNormalTexture();
    expect(flatNormal.id).toBe(BUILTIN_TEXTURE_IDS.FlatNormal);
    expect(flatNormal.semantic).toBe('normal');
    expect(Array.from(flatNormal.data)).toEqual([128, 128, 255, 255]);

    const blackSrgb = createDefaultBlackSrgbTexture();
    expect(blackSrgb.id).toBe(BUILTIN_TEXTURE_IDS.BlackSrgb);
    expect(blackSrgb.semantic).toBe('color');
  });

  test('cooks canonical sampler document', () => {
    const samplerDoc: CanonicalSamplerDocument = {
      id: 'samp.test' as AssetId,
      kind: 'sampler',
      version: 1,
      magFilter: 'linear',
      minFilter: 'linear-mipmap-nearest',
      wrapS: 'clamp-to-edge',
      wrapT: 'repeat'
    };

    const cooked = cookCanonicalSampler(samplerDoc);
    expect(cooked.magFilter).toBe('linear');
    expect(cooked.minFilter).toBe('linear');
    expect(cooked.mipmapFilter).toBe('nearest');
    expect(cooked.addressModeU).toBe('clamp-to-edge');
    expect(cooked.addressModeV).toBe('repeat');

    // Test all 6 minFilter modes specifically checking nearest-mipmap-linear and linear-mipmap-nearest
    expect(cookCanonicalSampler({ ...samplerDoc, minFilter: 'nearest' })).toMatchObject({
      minFilter: 'nearest',
      mipmapFilter: 'nearest'
    });
    expect(cookCanonicalSampler({ ...samplerDoc, minFilter: 'linear' })).toMatchObject({
      minFilter: 'linear',
      mipmapFilter: 'linear'
    });
    expect(
      cookCanonicalSampler({ ...samplerDoc, minFilter: 'nearest-mipmap-nearest' })
    ).toMatchObject({
      minFilter: 'nearest',
      mipmapFilter: 'nearest'
    });
    expect(
      cookCanonicalSampler({ ...samplerDoc, minFilter: 'linear-mipmap-nearest' })
    ).toMatchObject({
      minFilter: 'linear',
      mipmapFilter: 'nearest'
    });
    expect(
      cookCanonicalSampler({ ...samplerDoc, minFilter: 'nearest-mipmap-linear' })
    ).toMatchObject({
      minFilter: 'nearest',
      mipmapFilter: 'linear'
    });
    expect(
      cookCanonicalSampler({ ...samplerDoc, minFilter: 'linear-mipmap-linear' })
    ).toMatchObject({
      minFilter: 'linear',
      mipmapFilter: 'linear'
    });
  });

  test('CookedTextureRegistry prepares and resolves resources on live RHI device', () => {
    const registry = new CookedTextureRegistry();

    const mockTexture: RHITexture = {
      label: 'mock-tex',
      format: 'rgba8unorm',
      usage: 0,
      state: 'live',
      generation: 1,
      createView: vi.fn(),
      dispose: vi.fn()
    } as unknown as RHITexture;

    const mockSampler: RHISampler = {
      label: 'mock-sampler',
      state: 'live',
      generation: 1,
      dispose: vi.fn()
    } as unknown as RHISampler;

    const mockDevice: RHIDevice = {
      state: 'live',
      generation: 1,
      createTexture: vi.fn().mockReturnValue(mockTexture),
      createSampler: vi.fn().mockReturnValue(mockSampler),
      queue: {
        writeTexture: vi.fn(),
        writeBuffer: vi.fn(),
        submit: vi.fn()
      }
    } as unknown as RHIDevice;

    registry.prepare(mockDevice);

    const resolvedWhite = registry.resolveTexture(BUILTIN_TEXTURE_IDS.WhiteSrgb);
    expect(resolvedWhite).toBeDefined();
    expect(resolvedWhite!.semantic).toBe('color');
    expect(resolvedWhite!.texture).toBe(mockTexture);

    const resolvedSampler = registry.resolveSampler('aether.sampler.linear-repeat');
    expect(resolvedSampler).toBeDefined();
    expect(resolvedSampler).toBe(mockSampler);

    registry.dispose();
  });

  test('cooks the same source texture under multiple roles with distinct IDs without registry collisions', () => {
    const rawDoc: CanonicalTextureDocument = {
      id: 'tex.shared' as AssetId,
      kind: 'texture',
      version: 1,
      width: 1,
      height: 1,
      data: new Uint8Array([128, 64, 32, 255])
    };

    const cookedColor = cookCanonicalTexture(rawDoc, 'base-color');
    const cookedData = cookCanonicalTexture(rawDoc, 'occlusion');

    expect(cookedColor.id).toBe('tex.shared:base-color');
    expect(cookedData.id).toBe('tex.shared:occlusion');
    expect(cookedColor.id).not.toBe(cookedData.id);
    expect(cookedColor.semantic).toBe('color');
    expect(cookedData.semantic).toBe('data');
    expect(cookedColor.format).toBe('rgba8unorm-srgb');
    expect(cookedData.format).toBe('rgba8unorm');

    const registry = new CookedTextureRegistry();
    registry.registerTexture(cookedColor);
    registry.registerTexture(cookedData);

    const mockTexColor: RHITexture = {
      label: 'mock-color',
      format: 'rgba8unorm-srgb',
      usage: 0,
      state: 'live',
      generation: 1,
      createView: vi.fn(),
      dispose: vi.fn()
    } as unknown as RHITexture;

    const mockTexData: RHITexture = {
      label: 'mock-data',
      format: 'rgba8unorm',
      usage: 0,
      state: 'live',
      generation: 1,
      createView: vi.fn(),
      dispose: vi.fn()
    } as unknown as RHITexture;

    const mockDevice: RHIDevice = {
      state: 'live',
      generation: 1,
      createTexture: vi.fn((desc) =>
        desc.format === 'rgba8unorm-srgb' ? mockTexColor : mockTexData
      ),
      createSampler: vi.fn().mockReturnValue({
        label: 'mock-sampler',
        state: 'live',
        generation: 1,
        dispose: vi.fn()
      }),
      queue: {
        writeTexture: vi.fn(),
        writeBuffer: vi.fn(),
        submit: vi.fn()
      }
    } as unknown as RHIDevice;

    registry.prepare(mockDevice);

    // Exact role-scoped lookups
    const resColor = registry.resolveTexture('tex.shared:base-color');
    expect(resColor).toBeDefined();
    expect(resColor!.semantic).toBe('color');
    expect(resColor!.texture).toBe(mockTexColor);

    const resData = registry.resolveTexture('tex.shared:occlusion');
    expect(resData).toBeDefined();
    expect(resData!.semantic).toBe('data');
    expect(resData!.texture).toBe(mockTexData);

    // Prefix lookup
    const resPrefix = registry.resolveTexture('tex.shared');
    expect(resPrefix).toBeDefined();

    registry.dispose();
  });
});
