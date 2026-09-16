// ============================================================================
// AetherEngine Shared Shader Module - Image-Based Lighting (IBL)
// Equirectangular environment map sampling, irradiance, prefiltered radiance,
// split-sum approximation with energy compensation.
// ============================================================================

/// Per-scene environment lighting parameters.
/// - `diffuseIrradiance`: Irradiance map intensity scale.
/// - `intensity`: Overall environment light intensity multiplier.
/// - `prefilteredRadiance`: Prefiltered radiance map intensity scale.
/// - `maxValidRadianceLod`: Maximum valid LOD level for the prefiltered radiance map.
struct EnvironmentData {
  diffuseIrradiance: vec3<f32>,
  intensity: f32,
  prefilteredRadiance: vec3<f32>,
  maxValidRadianceLod: f32,
};

@group(3) @binding(5) var<uniform> environmentData: EnvironmentData;
@group(3) @binding(6) var irradianceMap: texture_2d<f32>;
@group(3) @binding(7) var prefilteredRadianceMap: texture_2d<f32>;
@group(3) @binding(8) var environmentBrdfLut: texture_2d<f32>;
@group(3) @binding(9) var environmentSampler: sampler;

/// Evaluates image-based lighting contribution using the split-sum approximation
/// with multiscatter energy compensation.
///
/// Parameters:
/// - `normal`: Normalized surface normal in world space.
/// - `viewDirection`: Normalized view direction from fragment to camera.
/// - `baseColor`: Linear sRGB diffuse albedo.
/// - `metallic`: Surface metallicity in [0.0, 1.0].
/// - `roughness`: Perceptual roughness in [0.045, 1.0].
/// - `occlusion`: Ambient occlusion factor in [0.0 (fully occluded), 1.0 (no occlusion)].
///
/// Returns:
/// Indirect lighting contribution in linear sRGB.
fn evaluateIbl(
  normal: vec3<f32>,
  viewDirection: vec3<f32>,
  baseColor: vec3<f32>,
  metallic: f32,
  roughness: f32,
  occlusion: f32
) -> vec3<f32> {
  let f0 = vec3<f32>(0.04) * (1.0 - metallic) + baseColor * metallic;
  let fresnel = fresnelSchlick(max(dot(normal, viewDirection), 0.0), f0);
  let irradianceUv = directionToEquirectangularUv(normal);
  let reflection = reflect(-viewDirection, normal);
  let radianceUv = directionToEquirectangularUv(reflection);
  let irradiance = textureSample(irradianceMap, environmentSampler, irradianceUv).rgb *
    environmentData.diffuseIrradiance;
  let lod = clamp(roughness, 0.0, 1.0) * environmentData.maxValidRadianceLod;
  let prefiltered = textureSampleLevel(
    prefilteredRadianceMap, environmentSampler, radianceUv, lod
  ).rgb * environmentData.prefilteredRadiance;
  let brdf = textureSample(
    environmentBrdfLut,
    environmentSampler,
    vec2<f32>(max(dot(normal, viewDirection), 0.0), roughness)
  ).rg;
  let diffuse = (vec3<f32>(1.0) - fresnel) * (1.0 - metallic) *
    baseColor * irradiance / 3.14159265359;
  let singleScattering = prefiltered * (f0 * brdf.x + vec3<f32>(brdf.y));
  let energyCompensation = vec3<f32>(1.0) + f0 * (1.0 / max(brdf.x, 0.00001) - 1.0);
  let specular = singleScattering * energyCompensation;
  return (diffuse * occlusion + specular) * environmentData.intensity;
}
