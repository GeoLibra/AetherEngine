// ============================================================================
// AetherEngine Standard PBR Shader (Metallic-Roughness Workflow)
// Cook-Torrance microfacet specular BRDF + Lambertian diffuse direct lighting.
// ============================================================================

// ----------------------------------------------------------------------------
// Uniform Buffer Data Structures (UBO)
// ----------------------------------------------------------------------------

/// Per-draw object transform matrices in world space.
struct ObjectData {
  world: mat4x4<f32>,
  normalWorld: mat4x4<f32>,
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
  padding0: vec2<u32>,
};

/// Directional light source parameters.
/// - direction: Normalized direction vector pointing from surface to light (or light heading).
/// - illuminance: Reserved for HDR physically-based lighting; intentionally unused by current LDR baseline.
/// - color: Linear light color (rgb).
/// - padding: Explicit tail padding to complete 32-byte alignment.
struct DirectionalLightData {
  direction: vec3<f32>,
  // Reserved for HDR physically-based lighting; intentionally unused by current LDR baseline.
  illuminance: f32,
  color: vec3<f32>,
  padding: f32,
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
};

/// Interpolated fragment input in world coordinate space.
struct StandardLitFragmentInput {
  @location(0) normal: vec3<f32>,
  @location(1) worldPosition: vec3<f32>,
  @location(2) uv0: vec2<f32>,
  @location(3) uv1: vec2<f32>,
  @location(4) tangent: vec4<f32>,
};

// ----------------------------------------------------------------------------
// Resource Bindings (Organized by Update Frequency)
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
@group(3) @binding(0) var<uniform> lightData: DirectionalLightData;       // Group 3: Per-scene / Per-light

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
  @location(1) normal: vec3<f32>,
  @location(2) uv0: vec2<f32>,
  @location(3) uv1: vec2<f32>,
  @location(4) tangent: vec4<f32>
) -> StandardLitVertexOutput {
  // Transform vertex position to world space
  let worldPosition = objectData.world * vec4<f32>(position, 1.0);

  // Transform normal vector to world space via normal matrix
  let worldNormal = normalize((objectData.normalWorld * vec4<f32>(normal, 0.0)).xyz);
  let rawWorldTangent = (objectData.world * vec4<f32>(tangent.xyz, 0.0)).xyz;
  let worldTangent = normalize(rawWorldTangent - worldNormal * dot(worldNormal, rawWorldTangent));
  let world3 = mat3x3<f32>(objectData.world[0].xyz, objectData.world[1].xyz, objectData.world[2].xyz);
  let transformSign = select(-1.0, 1.0, determinant(world3) >= 0.0);

  return StandardLitVertexOutput(
    viewData.viewProjection * worldPosition, // Projected clip position
    worldNormal,                             // World normal for fragment shading
    worldPosition.xyz,
    uv0,
    uv1,
    vec4<f32>(worldTangent, tangent.w * transformSign)
  );
}

fn selectUv(index: u32, uv0: vec2<f32>, uv1: vec2<f32>) -> vec2<f32> {
  return select(uv0, uv1, index == 1u);
}

// ----------------------------------------------------------------------------
// Fragment Shader Stage
// ----------------------------------------------------------------------------

@fragment
fn standardLitFragment(
  fragmentInput: StandardLitFragmentInput
) -> @location(0) vec4<f32> {
  let baseSample = textureSample(baseColorTexture, surfaceSampler, selectUv(materialData.baseColorUvSet, fragmentInput.uv0, fragmentInput.uv1));
  let mrSample = textureSample(metallicRoughnessTexture, surfaceSampler, selectUv(materialData.metallicRoughnessUvSet, fragmentInput.uv0, fragmentInput.uv1));
  let normalSample = textureSample(normalTexture, surfaceSampler, selectUv(materialData.normalUvSet, fragmentInput.uv0, fragmentInput.uv1)).xyz * 2.0 - vec3<f32>(1.0);
  let ao = 1.0 + materialData.occlusionStrength * (textureSample(occlusionTexture, surfaceSampler, selectUv(materialData.occlusionUvSet, fragmentInput.uv0, fragmentInput.uv1)).r - 1.0);
  let emissive = materialData.emissiveFactor * textureSample(emissiveTexture, surfaceSampler, selectUv(materialData.emissiveUvSet, fragmentInput.uv0, fragmentInput.uv1)).rgb;
  let baseColor = materialData.baseColor * baseSample;
  if (materialData.alphaMask != 0u && baseColor.a < materialData.alphaCutoff) { discard; }
  let geometricNormal = normalize(fragmentInput.normal);
  let tangent = normalize(fragmentInput.tangent.xyz);
  let bitangent = cross(geometricNormal, tangent) * fragmentInput.tangent.w;
  let mapped = normalize(vec3<f32>(normalSample.xy * materialData.normalScale, normalSample.z));
  let normal = normalize(tangent * mapped.x + bitangent * mapped.y + geometricNormal * mapped.z);
  let lightDirection = -normalize(lightData.direction);
  let viewDirection = normalize(viewData.cameraPosition - fragmentInput.worldPosition);

  let lit = cookTorranceDirect(
    normal,
    viewDirection,
    lightDirection,
    baseColor.rgb,
    materialData.metallic * mrSample.b,
    materialData.roughness * mrSample.g,
    lightData.color
  );

  return vec4<f32>(lit * ao + emissive, baseColor.a);
}
