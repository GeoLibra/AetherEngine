import { describe, expect, test } from 'vitest';
import {
  STANDARD_LIT_BINDING_LAYOUT_HASH,
  STANDARD_LIT_FORWARD_ROLE,
  STANDARD_LIT_SHADER_MODULE_KEY,
  StandardLitMaterialSchema,
  createStandardLitMaterial
} from '../../src';

describe('standard-lit built-in material', () => {
  test('publishes a stable opaque material recipe and typed technique', () => {
    const material = createStandardLitMaterial();

    expect(material.asset).toMatchObject({
      id: 'aether.material.standard-lit',
      version: 2,
      schema: StandardLitMaterialSchema,
      renderState: {
        surface: 'opaque',
        depthTest: true,
        depthWrite: true,
        cullMode: 'back'
      },
      techniques: [
        {
          name: 'standard-lit-forward',
          passRole: STANDARD_LIT_FORWARD_ROLE,
          shader: {
            moduleKey: STANDARD_LIT_SHADER_MODULE_KEY,
            vertexEntry: 'standardLitVertex',
            fragmentEntry: 'standardLitFragment'
          },
          compatibility: {
            semanticTag: 'standard-lit',
            bindingLayoutHash: STANDARD_LIT_BINDING_LAYOUT_HASH,
            requiredMeshCapabilities: ['normal', 'uv0', 'uv1', 'tangent'],
            attachmentFormats: ['bgra8unorm', 'rgba8unorm'],
            depthStencilFormats: ['depth24plus'],
            sampleCounts: [1]
          }
        }
      ]
    });
    expect(material.instance.parameters.get(StandardLitMaterialSchema.fields.baseColor)).toEqual([
      1, 1, 1, 1
    ]);
    expect(material.instance.parameters.get(StandardLitMaterialSchema.fields.metallic)).toBe(0);
    expect(material.instance.parameters.get(StandardLitMaterialSchema.fields.roughness)).toBe(0.5);
    expect(
      material.instance.parameters.get(StandardLitMaterialSchema.fields.baseColorTexture)
    ).toEqual({
      kind: 'texture',
      assetId: 'aether.texture.white-srgb'
    });
    expect(
      material.instance.parameters.get(StandardLitMaterialSchema.fields.normalTexture)
    ).toEqual({
      kind: 'texture',
      assetId: 'aether.texture.flat-normal'
    });
    expect(material.instance.parameters.get(StandardLitMaterialSchema.fields.alphaCutoff)).toBe(
      0.5
    );
    expect(Object.isFrozen(material)).toBe(true);
  });

  test('publishes an alpha-mask recipe and snapshots every texture reference', () => {
    const baseColorTexture = { kind: 'texture' as const, assetId: 'paint-srgb' };
    const material = createStandardLitMaterial({
      alphaMode: 'mask',
      alphaCutoff: 0.3,
      doubleSided: true,
      baseColorTexture,
      metallicRoughnessTexture: { kind: 'texture', assetId: 'surface-data' },
      normalTexture: { kind: 'texture', assetId: 'normal-data' },
      occlusionTexture: { kind: 'texture', assetId: 'ao-data' },
      emissiveTexture: { kind: 'texture', assetId: 'emissive-srgb' },
      sampler: { kind: 'sampler', assetId: 'repeat-linear' },
      emissiveFactor: [0.2, 0.4, 0.8],
      normalScale: 0.75,
      occlusionStrength: 0.6,
      uvSets: { baseColor: 1, metallicRoughness: 0, normal: 1, occlusion: 0, emissive: 1 }
    });
    baseColorTexture.assetId = 'mutated';

    expect(material.asset.renderState).toMatchObject({
      surface: 'alpha-mask',
      cullMode: 'none'
    });
    expect(
      material.instance.parameters.get(StandardLitMaterialSchema.fields.baseColorTexture)
    ).toEqual({
      kind: 'texture',
      assetId: 'paint-srgb'
    });
    expect(
      material.instance.parameters.get(StandardLitMaterialSchema.fields.emissiveFactor)
    ).toEqual([0.2, 0.4, 0.8]);
    expect(material.instance.parameters.get(StandardLitMaterialSchema.fields.normalScale)).toBe(
      0.75
    );
    expect(
      material.instance.parameters.get(StandardLitMaterialSchema.fields.occlusionStrength)
    ).toBe(0.6);
    expect(material.instance.parameters.get(StandardLitMaterialSchema.fields.baseColorUvSet)).toBe(
      1
    );
  });

  test('copies validated linear base color and bounded surface values', () => {
    const color = [0.2, 0.4, 0.8, 1] as [number, number, number, number];
    const material = createStandardLitMaterial({
      baseColor: color,
      metallic: 0.25,
      roughness: 0.7
    });
    color[0] = 1;

    expect(material.instance.parameters.get(StandardLitMaterialSchema.fields.baseColor)).toEqual([
      0.2, 0.4, 0.8, 1
    ]);
    expect(material.instance.parameters.get(StandardLitMaterialSchema.fields.metallic)).toBe(0.25);
    expect(material.instance.parameters.get(StandardLitMaterialSchema.fields.roughness)).toBe(0.7);
  });

  test.each([
    [{ baseColor: [1, 1, Number.NaN, 1] }, 'baseColor'],
    [{ baseColor: [1, 1, 1] }, 'baseColor'],
    [{ metallic: -0.1 }, 'metallic'],
    [{ metallic: 1.1 }, 'metallic'],
    [{ roughness: Number.POSITIVE_INFINITY }, 'roughness'],
    [{ roughness: 2 }, 'roughness']
  ] as const)('rejects invalid standard-lit options %o', (options, field) => {
    expect(() => createStandardLitMaterial(options as never)).toThrow(
      `Standard-lit ${field} must contain finite normalized values.`
    );
  });
});
