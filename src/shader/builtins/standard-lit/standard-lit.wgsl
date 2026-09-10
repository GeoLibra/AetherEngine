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
  metallic: f32,
  roughness: f32,
  padding0: f32,
  padding1: f32,
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
};

/// Interpolated fragment input in world coordinate space.
struct StandardLitFragmentInput {
  @location(0) normal: vec3<f32>,
  @location(1) worldPosition: vec3<f32>,
};

// ----------------------------------------------------------------------------
// Resource Bindings (Organized by Update Frequency)
// ----------------------------------------------------------------------------

@group(0) @binding(0) var<uniform> objectData: ObjectData;               // Group 0: Per-draw
@group(1) @binding(0) var<uniform> viewData: ViewData;                   // Group 1: Per-view / Per-frame
@group(2) @binding(0) var<uniform> materialData: MaterialData;           // Group 2: Per-material
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
// Fragment Shader Stage
// ----------------------------------------------------------------------------

@fragment
fn standardLitFragment(
  fragmentInput: StandardLitFragmentInput
) -> @location(0) vec4<f32> {
  let normal = normalize(fragmentInput.normal);
  let lightDirection = -normalize(lightData.direction);
  let viewDirection = normalize(viewData.cameraPosition - fragmentInput.worldPosition);

  let lit = cookTorranceDirect(
    normal,
    viewDirection,
    lightDirection,
    materialData.baseColor.rgb,
    materialData.metallic,
    materialData.roughness,
    lightData.color
  );

  return vec4<f32>(lit, materialData.baseColor.a);
}
