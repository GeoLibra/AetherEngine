import { ShaderParameterWriter, type BufferLayoutManifest } from '../../shader';
import { normalizedLightDirection, orderLightsForGpu } from './light';
import type { PreparedLight } from './types';

export const LIGHT_KIND = Object.freeze({ directional: 0, point: 1, spot: 2 } as const);
export const LIGHT_FLAG_ENABLED = 1 << 0;
export const LIGHT_FLAG_CASTS_SHADOW = 1 << 1;

export interface PreparedLightBuffer {
  readonly bytes: ArrayBuffer;
  readonly lights: readonly PreparedLight[];
}

/** Writes light payloads only through reflected offsets and scalar kinds. */
export function writeReflectedLightBuffer(
  manifest: BufferLayoutManifest,
  input: readonly PreparedLight[]
): PreparedLightBuffer {
  const lights = orderLightsForGpu(input);
  assertIntegerField(manifest, 'count');
  for (let index = 0; index < lights.length; index++) {
    for (const field of ['kind', 'flags', 'layerMask']) {
      assertIntegerField(manifest, `lights[${index}].${field}`);
    }
  }
  const bytes = new ArrayBuffer(manifest.byteSize);
  const writer = new ShaderParameterWriter(manifest, bytes);
  writer.write('count', lights.length);
  for (let index = 0; index < lights.length; index++) {
    const light = lights[index]!;
    const prefix = `lights[${index}]`;
    const direction =
      light.kind === 'point' ? ([0, 0, 0] as const) : normalizedLightDirection(light.direction);
    const position = light.kind === 'directional' ? ([0, 0, 0] as const) : light.position;
    const range = light.kind === 'directional' ? 0 : light.range;
    const intensity =
      light.kind === 'directional' ? light.illuminanceLux : light.luminousIntensityCandela;
    const spotAngles =
      light.kind === 'spot'
        ? ([light.innerRadians, light.outerRadians] as const)
        : ([0, 0] as const);
    const flags =
      (light.enabled ? LIGHT_FLAG_ENABLED : 0) | (light.castsShadow ? LIGHT_FLAG_CASTS_SHADOW : 0);
    writer.write(`${prefix}.position`, position);
    writer.write(`${prefix}.kind`, LIGHT_KIND[light.kind]);
    writer.write(`${prefix}.direction`, direction);
    writer.write(`${prefix}.range`, range);
    writer.write(`${prefix}.colorLinear`, light.colorLinear);
    writer.write(`${prefix}.intensity`, intensity);
    writer.write(`${prefix}.spotAngles`, spotAngles);
    writer.write(`${prefix}.flags`, flags);
    writer.write(`${prefix}.layerMask`, light.layerMask);
  }
  return Object.freeze({ bytes, lights });
}

function assertIntegerField(manifest: BufferLayoutManifest, path: string): void {
  const field = manifest.fields.find((candidate) => candidate.path === path);
  if (field === undefined) throw new Error(`Light buffer manifest is missing field "${path}".`);
  if (field.scalarKind !== 'u32' || field.elementCount !== 1 || field.shape.kind !== 'scalar') {
    throw new Error(`Light buffer field "${path}" must use a scalar u32 layout.`);
  }
}
