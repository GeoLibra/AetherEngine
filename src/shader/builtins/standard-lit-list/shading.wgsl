// ============================================================================
// AetherEngine Standard PBR Shader (Metallic-Roughness Workflow)
// Cook-Torrance microfacet specular BRDF + Lambertian diffuse direct lighting.
// Shared shading logic: vertex stage, PBR evaluation, and light loops.
// IBL and shadow receiver functions are imported from shared shader modules.
// ============================================================================

// ----------------------------------------------------------------------------
// Uniform Buffer Data Structures (UBO)
// ----------------------------------------------------------------------------

/// Per-draw object transform matrices in world space.
struct ObjectData {
  world: mat4x4<f32>,
  normalWorld: mat4x4<f32>,
  receiver: u32,
};

/// Per-view camera matrices and world-space position (16-byte aligned).
struct ViewData {
  viewProjection: mat4x4<f32>, // 64 bytes
  cameraPosition: vec3<f32>,   // 12 bytes, alignment 16
};

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

struct StandardLitSurface {
  baseColor: vec4<f32>,
  normal: vec3<f32>,
  metallic: f32,
  emissive: vec3<f32>,
  roughness: f32,
  occlusion: f32,
};

struct ReceiverLightHeader { offset: u32, count: u32 };

// ----------------------------------------------------------------------------
// Stage Input / Output Interfaces
// ----------------------------------------------------------------------------

/// Output from vertex shader passed to the rasterizer and fragment shader.
struct StandardLitVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) worldPosition: vec3<f32>,
  @location(2) uv0: vec2<f32>,
  @location(3) uv1: vec2<f32>,
  @location(4) tangent: vec4<f32>,
  @location(5) color: vec4<f32>,
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
// Shared Resource Bindings
// ----------------------------------------------------------------------------

@group(0) @binding(0) var<uniform> objectData: ObjectData;               // Group 0: Per-draw
@group(1) @binding(0) var<uniform> viewData: ViewData;                   // Group 1: Per-view / Per-frame
@group(2) @binding(0) var<uniform> materialData: MaterialData;           // Group 2: Per-material
@group(2) @binding(1) var baseColorTexture: texture_2d<f32>;
@group(2) @binding(2) var metallicRoughnessTexture: texture_2d<f32>;
@group(2) @binding(3) var normalTexture: texture_2d<f32>;
@group(2) @binding(4) var occlusionTexture: texture_2d<f32>;
@group(2) @binding(5) var emissiveTexture: texture_2d<f32>;
@group(2) @binding(6) var surfaceSampler: sampler;

// Group 3 bindings 5..9 (environment) and 10..12 (shadow) are declared in
// imported modules: lighting/ibl.wgsl and lighting/shadow-receiver.wgsl.

// ----------------------------------------------------------------------------
// Surface Sampling & Shading Implementation
// ----------------------------------------------------------------------------

fn selectUv(index: u32, uv0: vec2<f32>, uv1: vec2<f32>) -> vec2<f32> {
  return select(uv0, uv1, index == 1u);
}


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

// ----------------------------------------------------------------------------
// Direct Light Evaluation
// ----------------------------------------------------------------------------

fn evaluatePackedLight(
  index: u32,
  worldPosition: vec3<f32>,
  normal: vec3<f32>,
  viewDirection: vec3<f32>,
  surface: StandardLitSurface
) -> vec3<f32> {
  let base = 4u + index * 12u;
  let vector = vec3<f32>(
    bitcast<f32>(lightWord(base + 4u)),
    bitcast<f32>(lightWord(base + 5u)),
    bitcast<f32>(lightWord(base + 6u))
  );
  let color = vec3<f32>(
    bitcast<f32>(lightWord(base + 8u)),
    bitcast<f32>(lightWord(base + 9u)),
    bitcast<f32>(lightWord(base + 10u))
  );
  let intensity = bitcast<f32>(lightWord(base + 11u));
  if (lightWord(base) == 0u) {
    let lightDirection = -normalize(vector);
    let visibility = directionalShadowVisibility(index, worldPosition, normal, lightDirection);
    return cookTorranceDirect(
      normal,
      viewDirection,
      lightDirection,
      surface.baseColor.rgb,
      surface.metallic,
      surface.roughness,
      color * intensity
    ) * visibility;
  }
  let delta = vector - worldPosition;
  let distanceSquared = max(dot(delta, delta), 0.000001);
  return cookTorranceDirect(
    normal,
    viewDirection,
    normalize(delta),
    surface.baseColor.rgb,
    surface.metallic,
    surface.roughness,
    color * intensity / distanceSquared
  );
}

// ----------------------------------------------------------------------------
// Image-Based Lighting Facade
// ----------------------------------------------------------------------------

/// Evaluates image-based lighting for a StandardLitSurface by unpacking surface
/// properties and delegating to the shared evaluateIbl module function.
fn evaluateSurfaceIbl(
  normal: vec3<f32>,
  viewDirection: vec3<f32>,
  surface: StandardLitSurface
) -> vec3<f32> {
  return evaluateIbl(
    normal,
    viewDirection,
    surface.baseColor.rgb,
    surface.metallic,
    surface.roughness,
    surface.occlusion
  );
}
