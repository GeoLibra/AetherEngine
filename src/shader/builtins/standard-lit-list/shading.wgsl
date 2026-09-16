// ============================================================================
// AetherEngine Standard PBR Shader (Metallic-Roughness Workflow)
// Cook-Torrance microfacet specular BRDF + Lambertian diffuse direct lighting.
// Shared shading logic: vertex stage, PBR evaluation, IBL, and light loops.
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

struct EnvironmentData {
  diffuseIrradiance: vec3<f32>,
  intensity: f32,
  prefilteredRadiance: vec3<f32>,
  maxValidRadianceLod: f32,
};

struct DirectionalShadowData {
  viewProjection: array<mat4x4<f32>, 4>,
  cameraView: mat4x4<f32>,
  splitDepths: vec4<f32>,
  params: vec4<f32>, // enabled, constant bias, slope bias, inverse resolution
  lightIndex: u32,
};

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
@group(3) @binding(5) var<uniform> environmentData: EnvironmentData;
@group(3) @binding(6) var irradianceMap: texture_2d<f32>;
@group(3) @binding(7) var prefilteredRadianceMap: texture_2d<f32>;
@group(3) @binding(8) var environmentBrdfLut: texture_2d<f32>;
@group(3) @binding(9) var environmentSampler: sampler;
@group(3) @binding(10) var<uniform> directionalShadowData: DirectionalShadowData;
@group(3) @binding(11) var directionalShadowMap: texture_depth_2d_array;
@group(3) @binding(12) var directionalShadowSampler: sampler_comparison;

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

fn directionalShadowVisibility(
  lightIndex: u32,
  worldPosition: vec3<f32>,
  normal: vec3<f32>,
  lightDirection: vec3<f32>
) -> f32 {
  if (directionalShadowData.params.x < 0.5 || lightIndex != directionalShadowData.lightIndex) {
    return 1.0;
  }
  let viewPosition = directionalShadowData.cameraView * vec4<f32>(worldPosition, 1.0);
  let viewDepth = -viewPosition.z;
  var cascade = 4u;
  for (var index = 0u; index < 4u; index += 1u) {
    if (cascade == 4u && viewDepth <= directionalShadowData.splitDepths[index]) {
      cascade = index;
    }
  }
  if (cascade == 4u) { return 1.0; }
  let clip = directionalShadowData.viewProjection[cascade] * vec4<f32>(worldPosition, 1.0);
  let projected = clip.xyz / clip.w;
  let uv = projected.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
  if (projected.z < 0.0 || projected.z > 1.0 || any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) {
    return 1.0;
  }
  let normalDotLight = clamp(dot(normal, lightDirection), 0.0, 1.0);
  let bias = directionalShadowData.params.y + directionalShadowData.params.z * (1.0 - normalDotLight);
  let texel = directionalShadowData.params.w;
  var visibility = 0.0;
  for (var y = -1; y <= 1; y += 1) {
    for (var x = -1; x <= 1; x += 1) {
      visibility += textureSampleCompareLevel(
        directionalShadowMap,
        directionalShadowSampler,
        uv + vec2<f32>(f32(x), f32(y)) * texel,
        i32(cascade),
        projected.z - bias
      );
    }
  }
  return visibility / 9.0;
}

// ----------------------------------------------------------------------------
// Image-Based Lighting (IBL)
// ----------------------------------------------------------------------------

fn directionToEquirectangularUv(direction: vec3<f32>) -> vec2<f32> {
  let normalized = normalize(direction);
  return vec2<f32>(
    atan2(normalized.z, normalized.x) * 0.15915494309 + 0.5,
    acos(clamp(normalized.y, -1.0, 1.0)) * 0.31830988618
  );
}

fn evaluateIbl(normal: vec3<f32>, viewDirection: vec3<f32>, surface: StandardLitSurface) -> vec3<f32> {
  let metallic = surface.metallic;
  let roughness = surface.roughness;
  let f0 = vec3<f32>(0.04) * (1.0 - metallic) + surface.baseColor.rgb * metallic;
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
    surface.baseColor.rgb * irradiance / 3.14159265359;
  let singleScattering = prefiltered * (f0 * brdf.x + vec3<f32>(brdf.y));
  let energyCompensation = vec3<f32>(1.0) + f0 * (1.0 / max(brdf.x, 0.00001) - 1.0);
  let specular = singleScattering * energyCompensation;
  return (diffuse * surface.occlusion + specular) * environmentData.intensity;
}


