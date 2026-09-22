import { STANDARD_LIT_SHADER_ARTIFACT, STANDARD_SHADOW_SHADER_ARTIFACT } from '../../shader';
import type { CookedShaderBufferLayout } from '../../shader/types';
import { StandardLitMaterialSchema, type StandardLitMaterial } from '../../material';
import type { RHIBuffer, RHIDevice } from '../../rhi/contracts';
import type { ExtractedView } from '../camera';
import type { RenderTransformFact } from '../mesh';
import type { RenderEntityId } from '../world';

const UNIFORM_BUFFER_USAGE = (1 << 3) | (1 << 6);

export function createBaselineUniformBuffer(
  device: RHIDevice,
  values: readonly number[] | Uint32Array
): RHIBuffer {
  const byteLength = Math.max(16, Math.ceil(values.length / 4) * 16);
  const buffer = device.createBuffer({ size: byteLength, usage: UNIFORM_BUFFER_USAGE });
  device.queue.writeBuffer(
    buffer,
    0,
    values instanceof Uint32Array ? values : new Float32Array(values)
  );
  return buffer;
}

function requireBufferLayout(
  bufferLayouts: readonly CookedShaderBufferLayout[],
  bufferName: string
): CookedShaderBufferLayout {
  const layout = bufferLayouts.find((b) => b.name === bufferName);
  if (!layout) {
    throw new Error(`Shader artifact missing "${bufferName}" buffer layout.`);
  }
  return layout;
}

function requireFieldWordOffset(layout: CookedShaderBufferLayout, path: string): number {
  const field = layout.fields.find((f) => f.path === path);
  if (!field) {
    throw new Error(`Buffer layout "${layout.name}" missing required field "${path}".`);
  }
  return field.offset >> 2;
}

// ----------------------------------------------------------------------------
// StandardLit Material Uniform Layout & Writer
// ----------------------------------------------------------------------------

const standardLitLayout = requireBufferLayout(
  STANDARD_LIT_SHADER_ARTIFACT.bufferLayouts,
  'materialData'
);

export const STANDARD_LIT_MATERIAL_UNIFORM_BYTE_SIZE = standardLitLayout.byteSize;
export const STANDARD_LIT_MATERIAL_UNIFORM_WORD_COUNT = standardLitLayout.byteSize >> 2;

export const STANDARD_LIT_MATERIAL_WORD_OFFSETS = Object.freeze({
  baseColor: requireFieldWordOffset(standardLitLayout, 'baseColor'),
  emissiveFactor: requireFieldWordOffset(standardLitLayout, 'emissiveFactor'),
  normalScale: requireFieldWordOffset(standardLitLayout, 'normalScale'),
  metallic: requireFieldWordOffset(standardLitLayout, 'metallic'),
  roughness: requireFieldWordOffset(standardLitLayout, 'roughness'),
  occlusionStrength: requireFieldWordOffset(standardLitLayout, 'occlusionStrength'),
  alphaCutoff: requireFieldWordOffset(standardLitLayout, 'alphaCutoff'),
  baseColorUvSet: requireFieldWordOffset(standardLitLayout, 'baseColorUvSet'),
  metallicRoughnessUvSet: requireFieldWordOffset(standardLitLayout, 'metallicRoughnessUvSet'),
  normalUvSet: requireFieldWordOffset(standardLitLayout, 'normalUvSet'),
  occlusionUvSet: requireFieldWordOffset(standardLitLayout, 'occlusionUvSet'),
  emissiveUvSet: requireFieldWordOffset(standardLitLayout, 'emissiveUvSet'),
  alphaMask: requireFieldWordOffset(standardLitLayout, 'alphaMask'),
  baseColorTransform: requireFieldWordOffset(standardLitLayout, 'baseColorTransform'),
  baseColorOffset: requireFieldWordOffset(standardLitLayout, 'baseColorOffset'),
  metallicRoughnessTransform: requireFieldWordOffset(
    standardLitLayout,
    'metallicRoughnessTransform'
  ),
  metallicRoughnessOffset: requireFieldWordOffset(standardLitLayout, 'metallicRoughnessOffset'),
  normalTransform: requireFieldWordOffset(standardLitLayout, 'normalTransform'),
  normalOffset: requireFieldWordOffset(standardLitLayout, 'normalOffset'),
  occlusionTransform: requireFieldWordOffset(standardLitLayout, 'occlusionTransform'),
  occlusionOffset: requireFieldWordOffset(standardLitLayout, 'occlusionOffset'),
  emissiveTransform: requireFieldWordOffset(standardLitLayout, 'emissiveTransform'),
  emissiveOffset: requireFieldWordOffset(standardLitLayout, 'emissiveOffset')
});

/** Typed writer for packing MaterialData uniforms without manual byte offset calculations. */
export class StandardLitMaterialUniformWriter {
  readonly words: Uint32Array;
  readonly floats: Float32Array;

  constructor(buffer?: ArrayBuffer) {
    const targetBuffer = buffer ?? new ArrayBuffer(STANDARD_LIT_MATERIAL_UNIFORM_BYTE_SIZE);
    if (targetBuffer.byteLength < STANDARD_LIT_MATERIAL_UNIFORM_BYTE_SIZE) {
      throw new Error(
        `Buffer byteLength ${targetBuffer.byteLength} is less than required ${STANDARD_LIT_MATERIAL_UNIFORM_BYTE_SIZE}.`
      );
    }
    this.words = new Uint32Array(targetBuffer, 0, STANDARD_LIT_MATERIAL_UNIFORM_WORD_COUNT);
    this.floats = new Float32Array(targetBuffer, 0, STANDARD_LIT_MATERIAL_UNIFORM_WORD_COUNT);
  }

  setBaseColor(color: ArrayLike<number>): void {
    const o = STANDARD_LIT_MATERIAL_WORD_OFFSETS.baseColor;
    this.floats[o] = color[0]!;
    this.floats[o + 1] = color[1]!;
    this.floats[o + 2] = color[2]!;
    this.floats[o + 3] = color[3]!;
  }

  setEmissiveFactor(emissive: ArrayLike<number>): void {
    const o = STANDARD_LIT_MATERIAL_WORD_OFFSETS.emissiveFactor;
    this.floats[o] = emissive[0]!;
    this.floats[o + 1] = emissive[1]!;
    this.floats[o + 2] = emissive[2]!;
  }

  setNormalScale(scale: number): void {
    this.floats[STANDARD_LIT_MATERIAL_WORD_OFFSETS.normalScale] = scale;
  }

  setMetallic(metallic: number): void {
    this.floats[STANDARD_LIT_MATERIAL_WORD_OFFSETS.metallic] = metallic;
  }

  setRoughness(roughness: number): void {
    this.floats[STANDARD_LIT_MATERIAL_WORD_OFFSETS.roughness] = roughness;
  }

  setOcclusionStrength(strength: number): void {
    this.floats[STANDARD_LIT_MATERIAL_WORD_OFFSETS.occlusionStrength] = strength;
  }

  setAlphaCutoff(cutoff: number): void {
    this.floats[STANDARD_LIT_MATERIAL_WORD_OFFSETS.alphaCutoff] = cutoff;
  }

  setBaseColorUvSet(uvSet: number): void {
    this.words[STANDARD_LIT_MATERIAL_WORD_OFFSETS.baseColorUvSet] = uvSet;
  }

  setMetallicRoughnessUvSet(uvSet: number): void {
    this.words[STANDARD_LIT_MATERIAL_WORD_OFFSETS.metallicRoughnessUvSet] = uvSet;
  }

  setNormalUvSet(uvSet: number): void {
    this.words[STANDARD_LIT_MATERIAL_WORD_OFFSETS.normalUvSet] = uvSet;
  }

  setOcclusionUvSet(uvSet: number): void {
    this.words[STANDARD_LIT_MATERIAL_WORD_OFFSETS.occlusionUvSet] = uvSet;
  }

  setEmissiveUvSet(uvSet: number): void {
    this.words[STANDARD_LIT_MATERIAL_WORD_OFFSETS.emissiveUvSet] = uvSet;
  }

  setAlphaMask(mask: boolean | number): void {
    this.words[STANDARD_LIT_MATERIAL_WORD_OFFSETS.alphaMask] = mask ? 1 : 0;
  }

  setBaseColorTransform(matrix: ArrayLike<number>): void {
    this.floats.set(matrix, STANDARD_LIT_MATERIAL_WORD_OFFSETS.baseColorTransform);
  }

  setBaseColorOffset(offset: ArrayLike<number>): void {
    this.floats.set(offset, STANDARD_LIT_MATERIAL_WORD_OFFSETS.baseColorOffset);
  }

  setMetallicRoughnessTransform(matrix: ArrayLike<number>): void {
    this.floats.set(matrix, STANDARD_LIT_MATERIAL_WORD_OFFSETS.metallicRoughnessTransform);
  }

  setMetallicRoughnessOffset(offset: ArrayLike<number>): void {
    this.floats.set(offset, STANDARD_LIT_MATERIAL_WORD_OFFSETS.metallicRoughnessOffset);
  }

  setNormalTransform(matrix: ArrayLike<number>): void {
    this.floats.set(matrix, STANDARD_LIT_MATERIAL_WORD_OFFSETS.normalTransform);
  }

  setNormalOffset(offset: ArrayLike<number>): void {
    this.floats.set(offset, STANDARD_LIT_MATERIAL_WORD_OFFSETS.normalOffset);
  }

  setOcclusionTransform(matrix: ArrayLike<number>): void {
    this.floats.set(matrix, STANDARD_LIT_MATERIAL_WORD_OFFSETS.occlusionTransform);
  }

  setOcclusionOffset(offset: ArrayLike<number>): void {
    this.floats.set(offset, STANDARD_LIT_MATERIAL_WORD_OFFSETS.occlusionOffset);
  }

  setEmissiveTransform(matrix: ArrayLike<number>): void {
    this.floats.set(matrix, STANDARD_LIT_MATERIAL_WORD_OFFSETS.emissiveTransform);
  }

  setEmissiveOffset(offset: ArrayLike<number>): void {
    this.floats.set(offset, STANDARD_LIT_MATERIAL_WORD_OFFSETS.emissiveOffset);
  }
}

export function packBaselineMaterialUniform(material: StandardLitMaterial): Uint32Array {
  const writer = new StandardLitMaterialUniformWriter();
  const params = material.instance.parameters;
  writer.setBaseColor(params.get(StandardLitMaterialSchema.fields.baseColor));
  writer.setEmissiveFactor(params.get(StandardLitMaterialSchema.fields.emissiveFactor));
  writer.setNormalScale(params.get(StandardLitMaterialSchema.fields.normalScale));
  writer.setMetallic(params.get(StandardLitMaterialSchema.fields.metallic));
  writer.setRoughness(params.get(StandardLitMaterialSchema.fields.roughness));
  writer.setOcclusionStrength(params.get(StandardLitMaterialSchema.fields.occlusionStrength));
  writer.setAlphaCutoff(params.get(StandardLitMaterialSchema.fields.alphaCutoff));
  writer.setBaseColorUvSet(params.get(StandardLitMaterialSchema.fields.baseColorUvSet));
  writer.setMetallicRoughnessUvSet(
    params.get(StandardLitMaterialSchema.fields.metallicRoughnessUvSet)
  );
  writer.setNormalUvSet(params.get(StandardLitMaterialSchema.fields.normalUvSet));
  writer.setOcclusionUvSet(params.get(StandardLitMaterialSchema.fields.occlusionUvSet));
  writer.setEmissiveUvSet(params.get(StandardLitMaterialSchema.fields.emissiveUvSet));
  writer.setAlphaMask(material.asset.renderState.surface === 'alpha-mask');
  writer.setBaseColorTransform(params.get(StandardLitMaterialSchema.fields.baseColorTransform));
  writer.setBaseColorOffset(params.get(StandardLitMaterialSchema.fields.baseColorOffset));
  writer.setMetallicRoughnessTransform(
    params.get(StandardLitMaterialSchema.fields.metallicRoughnessTransform)
  );
  writer.setMetallicRoughnessOffset(
    params.get(StandardLitMaterialSchema.fields.metallicRoughnessOffset)
  );
  writer.setNormalTransform(params.get(StandardLitMaterialSchema.fields.normalTransform));
  writer.setNormalOffset(params.get(StandardLitMaterialSchema.fields.normalOffset));
  writer.setOcclusionTransform(params.get(StandardLitMaterialSchema.fields.occlusionTransform));
  writer.setOcclusionOffset(params.get(StandardLitMaterialSchema.fields.occlusionOffset));
  writer.setEmissiveTransform(params.get(StandardLitMaterialSchema.fields.emissiveTransform));
  writer.setEmissiveOffset(params.get(StandardLitMaterialSchema.fields.emissiveOffset));
  return writer.words;
}

// ----------------------------------------------------------------------------
// StandardShadow Material Uniform Layout & Writer
// ----------------------------------------------------------------------------

const standardShadowLayout = requireBufferLayout(
  STANDARD_SHADOW_SHADER_ARTIFACT.bufferLayouts,
  'shadowMaterialData'
);

export const STANDARD_SHADOW_MATERIAL_UNIFORM_BYTE_SIZE = standardShadowLayout.byteSize;
export const STANDARD_SHADOW_MATERIAL_UNIFORM_WORD_COUNT = standardShadowLayout.byteSize >> 2;

export const STANDARD_SHADOW_MATERIAL_WORD_OFFSETS = Object.freeze({
  baseColorFactor: requireFieldWordOffset(standardShadowLayout, 'baseColorFactor'),
  alphaCutoff: requireFieldWordOffset(standardShadowLayout, 'alphaCutoff'),
  baseColorUvSet: requireFieldWordOffset(standardShadowLayout, 'baseColorUvSet'),
  alphaMask: requireFieldWordOffset(standardShadowLayout, 'alphaMask'),
  baseColorTransform: requireFieldWordOffset(standardShadowLayout, 'baseColorTransform'),
  baseColorOffset: requireFieldWordOffset(standardShadowLayout, 'baseColorOffset')
});

/** Typed writer for packing ShadowMaterialData uniforms without manual byte offset calculations. */
export class StandardShadowMaterialUniformWriter {
  readonly words: Uint32Array;
  readonly floats: Float32Array;

  constructor(buffer?: ArrayBuffer) {
    const targetBuffer = buffer ?? new ArrayBuffer(STANDARD_SHADOW_MATERIAL_UNIFORM_BYTE_SIZE);
    if (targetBuffer.byteLength < STANDARD_SHADOW_MATERIAL_UNIFORM_BYTE_SIZE) {
      throw new Error(
        `Buffer byteLength ${targetBuffer.byteLength} is less than required ${STANDARD_SHADOW_MATERIAL_UNIFORM_BYTE_SIZE}.`
      );
    }
    this.words = new Uint32Array(targetBuffer, 0, STANDARD_SHADOW_MATERIAL_UNIFORM_WORD_COUNT);
    this.floats = new Float32Array(targetBuffer, 0, STANDARD_SHADOW_MATERIAL_UNIFORM_WORD_COUNT);
  }

  setBaseColorFactor(color: ArrayLike<number>): void {
    const o = STANDARD_SHADOW_MATERIAL_WORD_OFFSETS.baseColorFactor;
    this.floats[o] = color[0]!;
    this.floats[o + 1] = color[1]!;
    this.floats[o + 2] = color[2]!;
    this.floats[o + 3] = color[3]!;
  }

  setAlphaCutoff(cutoff: number): void {
    this.floats[STANDARD_SHADOW_MATERIAL_WORD_OFFSETS.alphaCutoff] = cutoff;
  }

  setBaseColorUvSet(uvSet: number): void {
    this.words[STANDARD_SHADOW_MATERIAL_WORD_OFFSETS.baseColorUvSet] = uvSet;
  }

  setAlphaMask(mask: boolean | number): void {
    this.words[STANDARD_SHADOW_MATERIAL_WORD_OFFSETS.alphaMask] = mask ? 1 : 0;
  }

  setBaseColorTransform(matrix: ArrayLike<number>): void {
    this.floats.set(matrix, STANDARD_SHADOW_MATERIAL_WORD_OFFSETS.baseColorTransform);
  }

  setBaseColorOffset(offset: ArrayLike<number>): void {
    this.floats.set(offset, STANDARD_SHADOW_MATERIAL_WORD_OFFSETS.baseColorOffset);
  }
}

export function packBaselineShadowMaterialUniform(material: StandardLitMaterial): Uint32Array {
  const writer = new StandardShadowMaterialUniformWriter();
  const params = material.instance.parameters;
  writer.setBaseColorFactor(params.get(StandardLitMaterialSchema.fields.baseColor));
  writer.setAlphaCutoff(params.get(StandardLitMaterialSchema.fields.alphaCutoff));
  writer.setBaseColorUvSet(params.get(StandardLitMaterialSchema.fields.baseColorUvSet));
  writer.setAlphaMask(material.asset.renderState.surface === 'alpha-mask');
  writer.setBaseColorTransform(params.get(StandardLitMaterialSchema.fields.baseColorTransform));
  writer.setBaseColorOffset(params.get(StandardLitMaterialSchema.fields.baseColorOffset));
  return writer.words;
}

// ----------------------------------------------------------------------------
// Object & View Uniform Packing
// ----------------------------------------------------------------------------

export function packBaselineObjectUniform(
  transform: RenderTransformFact,
  entity: RenderEntityId
): Uint32Array {
  const normal = transform.normalMatrix;
  if (normal.length !== 9) throw new Error('Standard-lit normal matrix must contain nine values.');
  const floats = new Float32Array([
    ...transform.matrix,
    normal[0]!,
    normal[1]!,
    normal[2]!,
    0,
    normal[3]!,
    normal[4]!,
    normal[5]!,
    0,
    normal[6]!,
    normal[7]!,
    normal[8]!,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0
  ]);
  const words = new Uint32Array(floats.buffer);
  words[32] = entity;
  return words;
}

export function packBaselineViewUniform(view: ExtractedView): readonly number[] {
  return [
    ...Array.from(view.viewProjection),
    ...Array.from(view.view),
    view.cameraPosition[0],
    view.cameraPosition[1],
    view.cameraPosition[2],
    0
  ];
}
