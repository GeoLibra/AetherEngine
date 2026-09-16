// ============================================================================
// AetherEngine Shared Shader Module - Cook-Torrance Microfacet BRDF
// Pure microfacet specular (GGX + Smith + Fresnel-Schlick) and Lambertian diffuse direct lighting.
// ============================================================================

/// Computes (value)^5 using multiplication squaring: (x^2)^2 * x.
/// Used in the Fresnel-Schlick approximation.
fn fifthPower(value: f32) -> f32 {
  let squared = value * value;
  return squared * squared * value;
}

/// Normal Distribution Function (NDF / D-term): GGX / Trowbridge-Reitz.
/// Calculates the probability density of microfacets aligning with the half-vector H.
/// Uses alpha = roughness^2 following Disney's perceptual roughness mapping.
///
/// Parameters:
/// - `normal`: Normalized surface normal vector in world space.
/// - `halfDirection`: Normalized half-vector between view and light directions `normalize(V + L)`.
/// - `roughness`: Perceptual roughness in [0.045, 1.0].
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
///
/// Parameters:
/// - `normal`: Normalized surface normal in world space.
/// - `viewDirection`: Normalized unit vector from fragment to camera position.
/// - `lightDirection`: Normalized unit vector from fragment toward light source.
/// - `baseColor`: Linear sRGB diffuse albedo color `vec3<f32>`.
/// - `metallic`: Surface metallicity in [0.0, 1.0].
/// - `roughness`: Perceptual roughness in [0.0, 1.0] (clamped to 0.045 floor internally).
/// - `radiance`: Incoming light radiance spectrum `vec3<f32>`.
///
/// Returns:
/// Reflected radiance towards view direction in linear sRGB.
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
