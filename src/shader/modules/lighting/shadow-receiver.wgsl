// ============================================================================
// AetherEngine Shared Shader Module - Cascaded Directional Shadow Receiver
// Cascaded shadow map sampling with 3x3 PCF filter.
// ============================================================================

/// Cascaded directional shadow uniform buffer data structure.
/// - `viewProjection`: Light view-projection matrices for each cascade slice.
/// - `cameraView`: View matrix of the active rendering camera.
/// - `splitDepths`: Far split depths in view space for cascade selection.
/// - `params`: vec4(enabled, constantBias, slopeBias, inverseResolution).
/// - `lightIndex`: Index of the active shadow-casting directional light.
struct DirectionalShadowData {
  viewProjection: array<mat4x4<f32>, 4>,
  cameraView: mat4x4<f32>,
  splitDepths: vec4<f32>,
  params: vec4<f32>,
  lightIndex: u32,
};

@group(3) @binding(10) var<uniform> directionalShadowData: DirectionalShadowData;
@group(3) @binding(11) var directionalShadowMap: texture_depth_2d_array;
@group(3) @binding(12) var directionalShadowSampler: sampler_comparison;

/// Evaluates directional cascaded shadow visibility factor in [0.0, 1.0].
/// Performs cascade selection by view depth, clip projection, boundary rejection,
/// slope-scaled depth biasing, and 3x3 PCF percentage-closer filtering.
///
/// Parameters:
/// - `lightIndex`: Index of the light being evaluated.
/// - `worldPosition`: World space fragment position.
/// - `normal`: Surface normal in world space.
/// - `lightDirection`: Normalized direction towards the light source.
///
/// Returns:
/// Shadow visibility factor in [0.0 (fully shadowed), 1.0 (fully lit)].
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
  if (cascade == 4u) {
    return 1.0;
  }
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
