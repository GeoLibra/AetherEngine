// --- Source Fragment: src/shader/builtins/standard-lit-list/webgl2/light-access.wgsl ---
// ============================================================================
// AetherEngine Standard PBR Shader - WebGL2 Light Access
// Integer 2D texture bindings and texture-load light list accessors.
// ============================================================================

@group(3) @binding(0) var lightWords: texture_2d<u32>;
@group(3) @binding(1) var directionalWords: texture_2d<u32>;
@group(3) @binding(2) var headerWords: texture_2d<u32>;
@group(3) @binding(3) var indexWords: texture_2d<u32>;
@group(3) @binding(4) var overflowWords: texture_2d<u32>;

fn textureWord(source: texture_2d<u32>, word: u32) -> u32 {
  let dimensions = textureDimensions(source);
  let texel = word / 4u;
  return textureLoad(
    source, vec2i(i32(texel % dimensions.x), i32(texel / dimensions.x)), 0
  )[word % 4u];
}

fn lightWord(word: u32) -> u32 {
  return textureWord(lightWords, word);
}

fn directionalLightCount() -> u32 {
  return textureWord(overflowWords, 0u) & 0x3fffffffu;
}

fn directionalIndex(index: u32) -> u32 {
  return textureWord(directionalWords, index);
}

fn receiverLightHeader() -> ReceiverLightHeader {
  let dimensions = textureDimensions(headerWords);
  for (var texel = 0u; texel < dimensions.x * dimensions.y; texel += 1u) {
    let base = texel * 4u;
    let flags = textureWord(headerWords, base + 3u);
    if ((flags & 0x80000000u) != 0u && textureWord(headerWords, base) == objectData.receiver) {
      return ReceiverLightHeader(texel, textureWord(headerWords, base + 2u));
    }
  }
  return ReceiverLightHeader(0u, 0u);
}

fn receiverLightIndex(header: ReceiverLightHeader, index: u32) -> u32 {
  let listWidth = textureDimensions(indexWords).x;
  let fixedWord =
    (header.offset + (1u + index / 4u) * listWidth) * 4u + index % 4u;
  return textureWord(indexWords, fixedWord);
}


// --- Source Fragment: src/shader/builtins/standard-lit-list/shading.wgsl ---
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
  padding: vec3<u32>,
};

/// Per-view camera matrices and world-space position (16-byte aligned).
struct ViewData {
  viewProjection: mat4x4<f32>, // 64 bytes
  cameraPosition: vec3<f32>,   // 12 bytes, alignment 16
  padding: f32,                // 4 bytes
};

/// Per-material PBR surface parameters.
/// - baseColor: Linear sRGB color with alpha.
/// - metallic: Normalized [0.0 = dielectric, 1.0 = pure metal].
/// - roughness: Normalized perceptual roughness [0.0 = mirror smooth, 1.0 = completely rough].
/// - padding0, padding1: Explicit tail padding to complete 32-byte alignment.
struct MaterialData {
  baseColor: vec4<f32>,
  metallic: f32,
  roughness: f32,
  padding0: f32,
  padding1: f32,
};

struct ReceiverLightHeader { offset: u32, count: u32 };

struct EnvironmentData {
  diffuseIrradiance: vec3<f32>,
  intensity: f32,
  prefilteredRadiance: vec3<f32>,
  maxValidRadianceLod: f32,
};

// ----------------------------------------------------------------------------
// Stage Input / Output Interfaces
// ----------------------------------------------------------------------------

/// Output from vertex shader passed to the rasterizer and fragment shader.
struct StandardLitVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) worldPosition: vec3<f32>,
};

/// Interpolated fragment input in world coordinate space.
struct StandardLitFragmentInput {
  @location(0) normal: vec3<f32>,
  @location(1) worldPosition: vec3<f32>,
};

// ----------------------------------------------------------------------------
// Shared Resource Bindings
// ----------------------------------------------------------------------------

@group(0) @binding(0) var<uniform> objectData: ObjectData;               // Group 0: Per-draw
@group(1) @binding(0) var<uniform> viewData: ViewData;                   // Group 1: Per-view / Per-frame
@group(2) @binding(0) var<uniform> materialData: MaterialData;           // Group 2: Per-material
@group(3) @binding(5) var<uniform> environmentData: EnvironmentData;
@group(3) @binding(6) var irradianceMap: texture_2d<f32>;
@group(3) @binding(7) var prefilteredRadianceMap: texture_2d<f32>;
@group(3) @binding(8) var environmentBrdfLut: texture_2d<f32>;
@group(3) @binding(9) var environmentSampler: sampler;

// ----------------------------------------------------------------------------
// PBR Mathematical Helpers & Cook-Torrance BRDF Implementation
// ----------------------------------------------------------------------------

/// Computes (value)^5 using multiplication squaring: (x^2)^2 * x.
/// Used in the Fresnel-Schlick approximation.
fn fifthPower(value: f32) -> f32 {
  let squared = value * value;
  return squared * squared * value;
}

/// Normal Distribution Function (NDF / D-term): GGX / Trowbridge-Reitz.
/// Calculates the probability density of microfacets aligning with the half-vector H.
/// Uses alpha = roughness^2 following Disney's perceptual roughness mapping.
fn distributionGgx(normal: vec3<f32>, halfDirection: vec3<f32>, roughness: f32) -> f32 {
  let alpha = roughness * roughness;
  let normalDotHalf = max(dot(normal, halfDirection), 0.0);
  let normalCrossHalf = cross(normal, halfDirection);
  let oneMinusNormalDotHalfSquared = dot(normalCrossHalf, normalCrossHalf);
  let alphaNormalDotHalf = alpha * normalDotHalf;
  let denominator = oneMinusNormalDotHalfSquared + alphaNormalDotHalf * alphaNormalDotHalf;
  let alphaOverDenominator = alpha / denominator;
  return alphaOverDenominator * alphaOverDenominator / 3.14159265359;
}

/// Exact separable Smith-GGX masking term for one direction.
fn geometrySmithGgx(normalDotDirection: f32, alpha: f32) -> f32 {
  let alphaSquared = alpha * alpha;
  let root = sqrt(
    alphaSquared + (1.0 - alphaSquared) * normalDotDirection * normalDotDirection
  );
  return 2.0 * normalDotDirection / (normalDotDirection + root);
}

/// Geometric Shadowing Function (G-term): Smith's method.
/// Accounts for microfacets shadowing light incoming rays and masking outgoing view rays:
/// G(N, V, L) = G1(N . V) * G1(N . L)
fn geometrySmith(
  normal: vec3<f32>,
  viewDirection: vec3<f32>,
  lightDirection: vec3<f32>,
  roughness: f32
) -> f32 {
  let normalDotView = max(dot(normal, viewDirection), 0.0);
  let normalDotLight = max(dot(normal, lightDirection), 0.0);
  let alpha = roughness * roughness;
  return geometrySmithGgx(normalDotView, alpha) * geometrySmithGgx(normalDotLight, alpha);
}

/// Fresnel Equation (F-term): Fresnel-Schlick approximation.
/// Computes the ratio of reflected vs refracted light at normal incidence F0:
/// F(cosTheta) = F0 + (1 - F0) * (1 - cosTheta)^5
fn fresnelSchlick(cosine: f32, f0: vec3<f32>) -> vec3<f32> {
  let cosTheta = clamp(cosine, 0.0, 1.0);
  return f0 + (vec3<f32>(1.0) - f0) * fifthPower(1.0 - cosTheta);
}

/// Evaluates direct Cook-Torrance microfacet BRDF + Lambertian diffuse:
/// Out = (k_d * f_diffuse + f_specular) * Radiance * (N . L)
fn cookTorranceDirect(
  normal: vec3<f32>,
  viewDirection: vec3<f32>,
  lightDirection: vec3<f32>,
  baseColor: vec3<f32>,
  metallic: f32,
  roughness: f32,
  radiance: vec3<f32>
) -> vec3<f32> {
  let normalDotLight = max(dot(normal, lightDirection), 0.0);
  let normalDotView = max(dot(normal, viewDirection), 0.0);
  if (normalDotLight <= 0.0 || normalDotView <= 0.0) {
    return vec3<f32>(0.0);
  }

  let halfDirection = normalize(viewDirection + lightDirection);

  // Clamp metallic and roughness to prevent non-physical energy amplification and numerical instability
  let clampedMetallic = clamp(metallic, 0.0, 1.0);
  let clampedRoughness = clamp(roughness, 0.045, 1.0);

  // Evaluate D (distribution), G (geometry shadowing), and F (Fresnel) terms
  let distribution = distributionGgx(normal, halfDirection, clampedRoughness);
  let geometry = geometrySmith(normal, viewDirection, lightDirection, clampedRoughness);

  // Dielectric surfaces have ~0.04 base specular reflectance; conductors use baseColor
  let f0 = vec3<f32>(0.04) * (1.0 - clampedMetallic) + baseColor * clampedMetallic;
  let fresnel = fresnelSchlick(max(dot(viewDirection, halfDirection), 0.0), f0);

  // Energy conservation: diffuse fraction kd = (1 - ks) * (1 - metallic)
  let diffuseWeight = (vec3<f32>(1.0) - fresnel) * (1.0 - clampedMetallic);
  let diffuse = diffuseWeight * baseColor / 3.14159265359;

  // Cook-Torrance specular term: (D * G * F) / (4 * (N.V) * (N.L))
  let specular = distribution * geometry * fresnel /
    (4.0 * normalDotView * normalDotLight);

  return (diffuse + specular) * radiance * normalDotLight;
}

// ----------------------------------------------------------------------------
// Vertex Shader Stage
// ----------------------------------------------------------------------------

@vertex
fn standardLitVertex(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>
) -> StandardLitVertexOutput {
  // Transform vertex position to world space
  let worldPosition = objectData.world * vec4<f32>(position, 1.0);

  // Transform normal vector to world space via normal matrix
  let worldNormal = normalize((objectData.normalWorld * vec4<f32>(normal, 0.0)).xyz);

  return StandardLitVertexOutput(
    viewData.viewProjection * worldPosition, // Projected clip position
    worldNormal,                             // World normal for fragment shading
    worldPosition.xyz                        // World position for view direction calculation
  );
}

// ----------------------------------------------------------------------------
// Direct Light Evaluation
// ----------------------------------------------------------------------------

fn evaluatePackedLight(
  index: u32,
  worldPosition: vec3<f32>,
  normal: vec3<f32>,
  viewDirection: vec3<f32>
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
    return cookTorranceDirect(
      normal,
      viewDirection,
      -normalize(vector),
      materialData.baseColor.rgb,
      materialData.metallic,
      materialData.roughness,
      color * intensity
    );
  }
  let delta = vector - worldPosition;
  let distanceSquared = max(dot(delta, delta), 0.000001);
  return cookTorranceDirect(
    normal,
    viewDirection,
    normalize(delta),
    materialData.baseColor.rgb,
    materialData.metallic,
    materialData.roughness,
    color * intensity / distanceSquared
  );
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

fn evaluateIbl(normal: vec3<f32>, viewDirection: vec3<f32>) -> vec3<f32> {
  let metallic = clamp(materialData.metallic, 0.0, 1.0);
  let roughness = clamp(materialData.roughness, 0.045, 1.0);
  let f0 = vec3<f32>(0.04) * (1.0 - metallic) + materialData.baseColor.rgb * metallic;
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
    materialData.baseColor.rgb * irradiance / 3.14159265359;
  let specular = prefiltered * (f0 * brdf.x + vec3<f32>(brdf.y));
  return (diffuse + specular) * environmentData.intensity;
}

// ----------------------------------------------------------------------------
// Fragment Shader Stage
// ----------------------------------------------------------------------------

@fragment
fn standardLitFragment(
  fragmentInput: StandardLitFragmentInput
) -> @location(0) vec4<f32> {
  let normal = normalize(fragmentInput.normal);
  let viewDirection = normalize(viewData.cameraPosition - fragmentInput.worldPosition);
  var lit = evaluateIbl(normal, viewDirection);
  let directionalCount = directionalLightCount();
  for (var index = 0u; index < directionalCount; index += 1u) {
    lit += evaluatePackedLight(
      directionalIndex(index), fragmentInput.worldPosition, normal, viewDirection
    );
  }
  let header = receiverLightHeader();
  for (var index = 0u; index < header.count; index += 1u) {
    lit += evaluatePackedLight(
      receiverLightIndex(header, index), fragmentInput.worldPosition, normal, viewDirection
    );
  }

  return vec4<f32>(lit, materialData.baseColor.a);
}

