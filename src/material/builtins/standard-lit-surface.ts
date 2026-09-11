/** Four-channel texture sample after the texture asset's declared transfer decode. */
export type StandardLitTextureSample = readonly [number, number, number, number];

export interface StandardLitSurfaceSamples {
  readonly baseColor: StandardLitTextureSample;
  readonly metallicRoughness: StandardLitTextureSample;
  readonly normal: StandardLitTextureSample;
  readonly occlusion: StandardLitTextureSample;
  readonly emissive: StandardLitTextureSample;
}

export interface StandardLitSurfaceEvaluationInput {
  readonly baseColorFactor: readonly [number, number, number, number];
  readonly metallicFactor: number;
  readonly roughnessFactor: number;
  readonly emissiveFactor: readonly [number, number, number];
  readonly normalScale: number;
  readonly occlusionStrength: number;
  readonly alphaMode?: 'opaque' | 'mask';
  readonly alphaCutoff?: number;
  readonly samples: StandardLitSurfaceSamples;
}

export interface StandardLitSurface {
  readonly baseColor: readonly [number, number, number, number];
  readonly metallic: number;
  readonly roughness: number;
  readonly tangentNormal: readonly [number, number, number];
  readonly occlusion: number;
  readonly emissive: readonly [number, number, number];
  readonly covered: boolean;
}

/** CPU reference for the StandardLit v2 texture-channel and coverage contract. */
export function evaluateStandardLitSurface(
  input: StandardLitSurfaceEvaluationInput
): StandardLitSurface {
  const { samples } = input;
  const baseColor = multiply4(input.baseColorFactor, samples.baseColor);
  const tangentNormal = normalize3([
    (samples.normal[0] * 2 - 1) * input.normalScale,
    (samples.normal[1] * 2 - 1) * input.normalScale,
    samples.normal[2] * 2 - 1
  ]);
  const alphaMode = input.alphaMode ?? 'opaque';
  const alphaCutoff = input.alphaCutoff ?? 0.5;
  return Object.freeze({
    baseColor: Object.freeze(baseColor),
    metallic: input.metallicFactor * samples.metallicRoughness[2],
    roughness: input.roughnessFactor * samples.metallicRoughness[1],
    tangentNormal: Object.freeze(tangentNormal),
    occlusion: 1 + input.occlusionStrength * (samples.occlusion[0] - 1),
    emissive: Object.freeze([
      input.emissiveFactor[0] * samples.emissive[0],
      input.emissiveFactor[1] * samples.emissive[1],
      input.emissiveFactor[2] * samples.emissive[2]
    ] as const),
    covered: alphaMode === 'opaque' || baseColor[3] >= alphaCutoff
  });
}

function multiply4(
  left: readonly [number, number, number, number],
  right: StandardLitTextureSample
): [number, number, number, number] {
  return [left[0] * right[0], left[1] * right[1], left[2] * right[2], left[3] * right[3]];
}

function normalize3(value: readonly [number, number, number]): [number, number, number] {
  const length = Math.hypot(...value);
  if (length === 0) return [0, 0, 1];
  return [value[0] / length, value[1] / length, value[2] / length];
}
