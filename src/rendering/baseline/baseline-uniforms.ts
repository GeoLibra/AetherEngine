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

export function packBaselineMaterialUniform(material: StandardLitMaterial): Uint32Array {
  const baseColor = material.instance.parameters.get(StandardLitMaterialSchema.fields.baseColor);
  const emissive = material.instance.parameters.get(
    StandardLitMaterialSchema.fields.emissiveFactor
  );
  const floats = new Float32Array([
    ...baseColor,
    ...emissive,
    material.instance.parameters.get(StandardLitMaterialSchema.fields.normalScale),
    material.instance.parameters.get(StandardLitMaterialSchema.fields.metallic),
    material.instance.parameters.get(StandardLitMaterialSchema.fields.roughness),
    material.instance.parameters.get(StandardLitMaterialSchema.fields.occlusionStrength),
    material.instance.parameters.get(StandardLitMaterialSchema.fields.alphaCutoff),
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0
  ]);
  const words = new Uint32Array(floats.buffer);
  words[12] = material.instance.parameters.get(StandardLitMaterialSchema.fields.baseColorUvSet);
  words[13] = material.instance.parameters.get(
    StandardLitMaterialSchema.fields.metallicRoughnessUvSet
  );
  words[14] = material.instance.parameters.get(StandardLitMaterialSchema.fields.normalUvSet);
  words[15] = material.instance.parameters.get(StandardLitMaterialSchema.fields.occlusionUvSet);
  words[16] = material.instance.parameters.get(StandardLitMaterialSchema.fields.emissiveUvSet);
  words[17] = material.asset.renderState.surface === 'alpha-mask' ? 1 : 0;
  return words;
}

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
    0,
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
    view.cameraPosition[0],
    view.cameraPosition[1],
    view.cameraPosition[2],
    0
  ];
}
