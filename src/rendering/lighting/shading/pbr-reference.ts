import { Vec3Math } from '../../../math';
import type { Vec3 } from '../../../math/types';

const PI = Math.PI;
const MIN_PERCEPTUAL_ROUGHNESS = 0.045;

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

/** Inputs for the Fdez-Aguera split-sum multiple-scattering compensation profile. */
export interface MultipleScatteringIblInput {
  readonly singleScattering: Vec3;
  readonly f0: Vec3;
  /** Directional albedo stored in the first channel of the StandardLit BRDF LUT. */
  readonly directionalAlbedo: number;
}

/**
 * Restores energy lost by the single-scattering microfacet IBL approximation.
 *
 * The zero-albedo boundary is evaluated with the same finite floor used by the shader. A zero
 * single-scattering input therefore remains finite and black.
 */
export function compensateMultipleScatteringIbl(input: MultipleScatteringIblInput): Vec3 {
  const singleScattering = nonNegativeColor(input.singleScattering, 'singleScattering');
  const f0 = normalizedColor(input.f0, 'f0');
  if (
    !Number.isFinite(input.directionalAlbedo) ||
    input.directionalAlbedo < 0 ||
    input.directionalAlbedo > 1
  ) {
    throw new Error('PBR directionalAlbedo must be finite and normalized.');
  }
  const inverseAlbedoMinusOne = 1 / Math.max(input.directionalAlbedo, 1e-5) - 1;
  return Vec3Math.multiply(
    singleScattering,
    Vec3Math.add(WHITE, Vec3Math.scale(f0, inverseAlbedoMinusOne))
  );
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
  const normal = Vec3Math.normalize(input.normal, 'PBR normal');
  const view = Vec3Math.normalize(input.viewDirection, 'PBR viewDirection');
  const light = Vec3Math.normalize(input.lightDirection, 'PBR lightDirection');
  const normalDotLight = Math.max(Vec3Math.dot(normal, light), 0); // n · l
  const normalDotView = Math.max(Vec3Math.dot(normal, view), 0); // n · v
  if (normalDotLight === 0 || normalDotView === 0) return BLACK;
  const half = Vec3Math.normalize(Vec3Math.add(view, light), 'PBR viewDirection + lightDirection');
  const normalDotHalf = Math.max(Vec3Math.dot(normal, half), 0);
  const viewDotHalf = Math.max(Vec3Math.dot(view, half), 0);

  const alpha = roughness * roughness;
  const normalCrossHalf = Vec3Math.cross(normal, half);
  const oneMinusNormalDotHalfSquared = Vec3Math.lengthSq(normalCrossHalf);
  const alphaNormalDotHalf = alpha * normalDotHalf;
  const distributionDenominator =
    oneMinusNormalDotHalfSquared + alphaNormalDotHalf * alphaNormalDotHalf;
  const alphaOverDenominator = alpha / distributionDenominator;
  const distribution = (alphaOverDenominator * alphaOverDenominator) / PI;
  const geometry = smithGgx(normalDotView, alpha) * smithGgx(normalDotLight, alpha);
  const f0 = Vec3Math.lerp(DIELECTRIC_F0, baseColor, metallic);
  const fresnelFactor = fifthPower(1 - viewDotHalf);
  const fresnel = Vec3Math.lerp(f0, WHITE, fresnelFactor);
  const diffuseWeight = Vec3Math.scale(Vec3Math.subtract(WHITE, fresnel), 1 - metallic);
  const diffuse = Vec3Math.scale(Vec3Math.multiply(diffuseWeight, baseColor), 1 / PI);
  const specular = Vec3Math.scale(
    fresnel,
    (distribution * geometry) / (4 * normalDotView * normalDotLight)
  );
  return Vec3Math.scale(
    Vec3Math.multiply(Vec3Math.add(diffuse, specular), radiance),
    normalDotLight
  );
}

const BLACK = Vec3Math.zero();
const WHITE = Vec3Math.one();
const DIELECTRIC_F0 = Object.freeze([0.04, 0.04, 0.04] as const);

function smithGgx(normalDotDirection: number, alpha: number): number {
  const alphaSquared = alpha * alpha;
  const root = Math.sqrt(
    alphaSquared + (1 - alphaSquared) * normalDotDirection * normalDotDirection
  );
  return (2 * normalDotDirection) / (normalDotDirection + root);
}

function fifthPower(value: number): number {
  const squared = value * value;
  return squared * squared * value;
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
