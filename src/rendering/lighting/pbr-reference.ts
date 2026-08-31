const PI = Math.PI;
const MIN_PERCEPTUAL_ROUGHNESS = 0.045;
const MIN_BRDF_DENOMINATOR = 1e-6;

type Vec3 = readonly [number, number, number];

/** Inputs for the deterministic CPU oracle of the direct-light metallic-roughness BRDF. */
export interface CookTorranceDirectInput {
  readonly baseColorLinear: Vec3;
  readonly metallic: number;
  readonly roughness: number;
  readonly normal: Vec3;
  readonly viewDirection: Vec3;
  readonly lightDirection: Vec3;
  readonly lightRadianceLinear: Vec3;
}

/**
 * Evaluates one GGX/Smith/Schlick direct-light sample in scene-linear space.
 *
 * This is the CPU correctness oracle for shader corpus and backend comparisons, not a hot-frame
 * lighting implementation. Directions may be unnormalized but must be finite and non-zero.
 *
 * @throws When colors, material parameters, or directions are outside their declared domains.
 */
export function evaluateCookTorranceDirect(input: CookTorranceDirectInput): Vec3 {
  const baseColor = normalizedColor(input.baseColorLinear, 'baseColorLinear');
  const radiance = nonNegativeColor(input.lightRadianceLinear, 'lightRadianceLinear');
  const metallic = normalizedScalar(input.metallic, 'metallic');
  const roughness = Math.max(
    MIN_PERCEPTUAL_ROUGHNESS,
    normalizedScalar(input.roughness, 'roughness')
  );
  const normal = normalizedDirection(input.normal, 'normal');
  const view = normalizedDirection(input.viewDirection, 'viewDirection');
  const light = normalizedDirection(input.lightDirection, 'lightDirection');
  const normalDotLight = Math.max(dot(normal, light), 0);
  const normalDotView = Math.max(dot(normal, view), 0);
  if (normalDotLight === 0 || normalDotView === 0) return BLACK;
  const half = normalizedDirection(add(view, light), 'viewDirection + lightDirection');
  const normalDotHalf = Math.max(dot(normal, half), 0);
  const viewDotHalf = Math.max(dot(view, half), 0);

  const alpha = roughness * roughness;
  const alphaSquared = alpha * alpha;
  const distributionDenominator = normalDotHalf * normalDotHalf * (alphaSquared - 1) + 1;
  const distribution =
    alphaSquared /
    Math.max(PI * distributionDenominator * distributionDenominator, MIN_BRDF_DENOMINATOR);
  const geometryK = ((roughness + 1) * (roughness + 1)) / 8;
  const geometry = smithSchlick(normalDotView, geometryK) * smithSchlick(normalDotLight, geometryK);
  const f0 = mixColor(DIELECTRIC_F0, baseColor, metallic);
  const fresnelFactor = fifthPower(1 - viewDotHalf);
  const fresnel = mixColor(f0, WHITE, fresnelFactor);
  const diffuseWeight = scale(subtract(WHITE, fresnel), 1 - metallic);
  const diffuse = scale(multiply(diffuseWeight, baseColor), 1 / PI);
  const specular = scale(
    fresnel,
    (distribution * geometry) / Math.max(4 * normalDotView * normalDotLight, MIN_BRDF_DENOMINATOR)
  );
  return freezeVec3(scale(multiply(add(diffuse, specular), radiance), normalDotLight));
}

const BLACK = Object.freeze([0, 0, 0] as const);
const WHITE = Object.freeze([1, 1, 1] as const);
const DIELECTRIC_F0 = Object.freeze([0.04, 0.04, 0.04] as const);

function smithSchlick(normalDotDirection: number, k: number): number {
  return normalDotDirection / Math.max(normalDotDirection * (1 - k) + k, MIN_BRDF_DENOMINATOR);
}

function fifthPower(value: number): number {
  const squared = value * value;
  return squared * squared * value;
}

function dot(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function add(left: Vec3, right: Vec3): Vec3 {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function multiply(left: Vec3, right: Vec3): Vec3 {
  return [left[0] * right[0], left[1] * right[1], left[2] * right[2]];
}

function scale(value: Vec3, factor: number): Vec3 {
  return [value[0] * factor, value[1] * factor, value[2] * factor];
}

function mixColor(from: Vec3, to: Vec3, factor: number): Vec3 {
  return add(scale(from, 1 - factor), scale(to, factor));
}

function normalizedDirection(value: Vec3, name: string): Vec3 {
  finiteVec3(value, name);
  const length = Math.hypot(value[0], value[1], value[2]);
  if (length <= Number.EPSILON) throw new Error(`PBR ${name} must be non-zero.`);
  return [value[0] / length, value[1] / length, value[2] / length];
}

function normalizedColor(value: Vec3, name: string): Vec3 {
  finiteVec3(value, name);
  if (value.some((component) => component < 0 || component > 1))
    throw new Error(`PBR ${name} must contain normalized linear values.`);
  return value;
}

function nonNegativeColor(value: Vec3, name: string): Vec3 {
  finiteVec3(value, name);
  if (value.some((component) => component < 0))
    throw new Error(`PBR ${name} must contain non-negative linear values.`);
  return value;
}

function normalizedScalar(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new Error(`PBR ${name} must be finite and normalized.`);
  return value;
}

function finiteVec3(value: Vec3, name: string): void {
  if (value.length !== 3 || value.some((component) => !Number.isFinite(component)))
    throw new Error(`PBR ${name} must contain three finite values.`);
}

function freezeVec3(value: Vec3): Vec3 {
  return Object.freeze([value[0], value[1], value[2]]);
}
