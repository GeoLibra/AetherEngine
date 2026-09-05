import type { ShaderSourceResolver } from '../../../types';

export const AETHER_SHADER_STANDARD_LIBRARY_VERSION = 1;
export const AETHER_SHADER_STANDARD_LIBRARY_ROOT = 'asset://aether/stdlib';

const MODULES: Readonly<Record<string, string>> = Object.freeze({
  [`${AETHER_SHADER_STANDARD_LIBRARY_ROOT}/math.flux`]: [
    'fn saturate(value: f32) -> f32 { return clamp(value, 0.0, 1.0); }',
    'fn square(value: f32) -> f32 { return value * value; }'
  ].join('\n'),
  [`${AETHER_SHADER_STANDARD_LIBRARY_ROOT}/noise.flux`]: [
    '@include "./math.flux";',
    'fn hash11(value: f32) -> f32 { return saturate(value * 0.1031); }'
  ].join('\n'),
  [`${AETHER_SHADER_STANDARD_LIBRARY_ROOT}/pbr.flux`]: [
    '@include "./math.flux";',
    'fn perceptualRoughness(value: f32) -> f32 { return square(saturate(value)); }'
  ].join('\n'),
  [`${AETHER_SHADER_STANDARD_LIBRARY_ROOT}/sdf.flux`]: [
    '@include "./math.flux";',
    'fn sdfSphere(distanceFromCenter: f32, radius: f32) -> f32 { return distanceFromCenter - radius; }'
  ].join('\n')
});

export class StandardLibraryShaderResolver implements ShaderSourceResolver {
  constructor(private readonly fallback?: ShaderSourceResolver) {}

  async load(uri: string): Promise<string> {
    const module = MODULES[uri];
    if (module !== undefined) return module;
    if (this.fallback) return this.fallback.load(uri);
    throw new Error(`Shader source not found: ${uri}`);
  }
}

export function shaderStandardLibraryModules(): Readonly<Record<string, string>> {
  return MODULES;
}
