// ============================================================================
// AetherEngine Shared Shader Module - Standard PBR Surface Sampling
// Metallic-Roughness material data, texture sampling, normal mapping, and surface packing.
// ============================================================================

/// Per-material PBR surface parameters.
/// - baseColor: Linear sRGB color with alpha.
/// - metallic: Normalized [0.0 = dielectric, 1.0 = pure metal].
/// - roughness: Normalized perceptual roughness [0.0 = mirror smooth, 1.0 = completely rough].
struct MaterialData {
  baseColor: vec4<f32>,
  emissiveFactor: vec3<f32>,
  normalScale: f32,
  metallic: f32,
  roughness: f32,
  occlusionStrength: f32,
  alphaCutoff: f32,
  baseColorUvSet: u32,
  metallicRoughnessUvSet: u32,
  normalUvSet: u32,
  occlusionUvSet: u32,
  emissiveUvSet: u32,
  alphaMask: u32,
  baseColorTransform: vec4<f32>,
  baseColorOffset: vec2<f32>,
  metallicRoughnessTransform: vec4<f32>,
  metallicRoughnessOffset: vec2<f32>,
  normalTransform: vec4<f32>,
  normalOffset: vec2<f32>,
  occlusionTransform: vec4<f32>,
  occlusionOffset: vec2<f32>,
  emissiveTransform: vec4<f32>,
  emissiveOffset: vec2<f32>,
};

/// Evaluated standard PBR surface data consumed by direct light and IBL passes.
struct StandardLitSurface {
  baseColor: vec4<f32>,
  normal: vec3<f32>,
  metallic: f32,
  emissive: vec3<f32>,
  roughness: f32,
  occlusion: f32,
};

/// Interpolated fragment input in world coordinate space.
struct StandardLitFragmentInput {
  @location(0) normal: vec3<f32>,
  @location(1) worldPosition: vec3<f32>,
  @location(2) uv0: vec2<f32>,
  @location(3) uv1: vec2<f32>,
  @location(4) tangent: vec4<f32>,
  @location(5) color: vec4<f32>,
};

// ----------------------------------------------------------------------------
// Group 2 Material Resource Bindings
// ----------------------------------------------------------------------------

@group(2) @binding(0) var<uniform> materialData: MaterialData;
@group(2) @binding(1) var baseColorTexture: texture_2d<f32>;
@group(2) @binding(2) var metallicRoughnessTexture: texture_2d<f32>;
@group(2) @binding(3) var normalTexture: texture_2d<f32>;
@group(2) @binding(4) var occlusionTexture: texture_2d<f32>;
@group(2) @binding(5) var emissiveTexture: texture_2d<f32>;
@group(2) @binding(6) var surfaceSampler: sampler;

// ----------------------------------------------------------------------------
// Surface Sampling Helpers
// ----------------------------------------------------------------------------

fn selectUv(index: u32, uv0: vec2<f32>, uv1: vec2<f32>) -> vec2<f32> {
  return select(uv0, uv1, index == 1u);
}

/// Evaluates and unpacks full metallic-roughness PBR surface properties from textures
/// and uniform factors, including TBN normal mapping and roughness clamping.
///
/// Parameters:
/// - `input`: Interpolated vertex attributes in world space.
/// - `frontFacing`: Built-in rasterizer front facing boolean for two-sided lighting.
///
/// Returns:
/// Populated StandardLitSurface structure.
fn sampleStandardLitSurface(input: StandardLitFragmentInput, frontFacing: bool) -> StandardLitSurface {
  let bcUv = transformUv(
    selectUv(materialData.baseColorUvSet, input.uv0, input.uv1),
    materialData.baseColorTransform,
    materialData.baseColorOffset
  );
  let mrUv = transformUv(
    selectUv(materialData.metallicRoughnessUvSet, input.uv0, input.uv1),
    materialData.metallicRoughnessTransform,
    materialData.metallicRoughnessOffset
  );
  let normUv = transformUv(
    selectUv(materialData.normalUvSet, input.uv0, input.uv1),
    materialData.normalTransform,
    materialData.normalOffset
  );
  let occUv = transformUv(
    selectUv(materialData.occlusionUvSet, input.uv0, input.uv1),
    materialData.occlusionTransform,
    materialData.occlusionOffset
  );
  let emUv = transformUv(
    selectUv(materialData.emissiveUvSet, input.uv0, input.uv1),
    materialData.emissiveTransform,
    materialData.emissiveOffset
  );

  let baseSample = textureSample(baseColorTexture, surfaceSampler, bcUv);
  let mrSample = textureSample(metallicRoughnessTexture, surfaceSampler, mrUv);
  let normalSample = textureSample(normalTexture, surfaceSampler, normUv).xyz * 2.0 - vec3<f32>(1.0);
  let aoSample = textureSample(occlusionTexture, surfaceSampler, occUv).r;
  let emissiveSample = textureSample(emissiveTexture, surfaceSampler, emUv).rgb;

  let rawNormal = normalize(input.normal);
  let geometricNormal = select(-rawNormal, rawNormal, frontFacing);
  let tangent = normalize(input.tangent.xyz);
  let bitangent = cross(geometricNormal, tangent) * input.tangent.w;
  let mapped = normalize(vec3<f32>(normalSample.xy * materialData.normalScale, normalSample.z));
  let worldNormal = normalize(tangent * mapped.x + bitangent * mapped.y + geometricNormal * mapped.z);

  return StandardLitSurface(
    materialData.baseColor * baseSample * input.color,
    worldNormal,
    clamp(materialData.metallic * mrSample.b, 0.0, 1.0),
    materialData.emissiveFactor * emissiveSample,
    clamp(materialData.roughness * mrSample.g, 0.045, 1.0),
    1.0 + materialData.occlusionStrength * (aoSample - 1.0)
  );
}
