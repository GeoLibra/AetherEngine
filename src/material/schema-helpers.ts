import type {
  MaterialFieldDefinition,
  MaterialSamplerReference,
  MaterialTextureReference
} from './types';

/**
 * Creates an immutable reference to a texture asset.
 */
export function createMaterialTextureReference(assetId: string): MaterialTextureReference {
  return Object.freeze({ kind: 'texture', assetId });
}

/**
 * Creates an immutable reference to a sampler asset.
 */
export function createMaterialSamplerReference(assetId: string): MaterialSamplerReference {
  return Object.freeze({ kind: 'sampler', assetId });
}

/**
 * Helper factory defining a texture reference parameter field in a material schema.
 */
export function defineTextureField(
  fieldId: string,
  name: string,
  defaultAssetId: string,
  bindingPath: string
): MaterialFieldDefinition<{ readonly kind: 'texture-reference' }> {
  return {
    fieldId,
    name,
    valueType: { kind: 'texture-reference' } as const,
    defaultValue: createMaterialTextureReference(defaultAssetId),
    bindingPath
  };
}

/**
 * Helper factory defining an unsigned 32-bit UV set index field (e.g. UV0 vs UV1).
 */
export function defineUvField(
  fieldId: string,
  name: string,
  bindingPath = `material.${name}`
): MaterialFieldDefinition<{ readonly kind: 'number'; readonly format: 'u32' }> {
  return {
    fieldId,
    name,
    valueType: { kind: 'number', format: 'u32' } as const,
    defaultValue: 0,
    bindingPath
  };
}

/**
 * Helper factory defining a 2D affine transform matrix field (column-major vec4).
 */
export function defineTransformField(
  fieldId: string,
  name: string,
  bindingPath = `material.${name}`
): MaterialFieldDefinition<{
  readonly kind: 'vector';
  readonly length: 4;
  readonly format: 'f32';
}> {
  return {
    fieldId,
    name,
    valueType: { kind: 'vector', length: 4, format: 'f32' } as const,
    defaultValue: [1, 0, 0, 1] as const,
    bindingPath
  };
}

/**
 * Helper factory defining a 2D translation offset field (vec2).
 */
export function defineOffsetField(
  fieldId: string,
  name: string,
  bindingPath = `material.${name}`
): MaterialFieldDefinition<{
  readonly kind: 'vector';
  readonly length: 2;
  readonly format: 'f32';
}> {
  return {
    fieldId,
    name,
    valueType: { kind: 'vector', length: 2, format: 'f32' } as const,
    defaultValue: [0, 0] as const,
    bindingPath
  };
}
