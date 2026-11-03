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
/// - `pcfRadius`: Integer PCF radius in shadow-map texels.
struct DirectionalShadowData {
  viewProjection: array<mat4x4<f32>, 4>,
  cameraView: mat4x4<f32>,
  splitDepths: vec4<f32>,
  params: vec4<f32>,
  lightIndex: u32,
  pcfRadius: u32,
};

@group(3) @binding(10) var<uniform> directionalShadowData: DirectionalShadowData;
@group(3) @binding(11) var directionalShadowMap: texture_depth_2d_array;
@group(3) @binding(12) var directionalShadowSampler: sampler_comparison;

/// Fixed-capacity local shadow receiver table. Records are uploaded as five vec4<u32> values:
/// metadata plus a spot matrix, or point near/far and an identity matrix placeholder.
struct LocalShadowReceiverData {
  words: array<vec4<u32>, 81>,
};

@group(3) @binding(13) var<uniform> localShadowReceiverData: LocalShadowReceiverData;

/// Evaluates directional cascaded shadow visibility factor in [0.0, 1.0].
/// Performs cascade selection by view depth, clip projection, boundary rejection,
/// slope-scaled depth biasing, and configurable 3x3 or 5x5 PCF percentage-closer filtering.
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
  let pcfRadius = i32(directionalShadowData.pcfRadius);
  var visibility = 0.0;
  for (var y = -pcfRadius; y <= pcfRadius; y += 1) {
    for (var x = -pcfRadius; x <= pcfRadius; x += 1) {
      visibility += textureSampleCompareLevel(
        directionalShadowMap,
        directionalShadowSampler,
        uv + vec2<f32>(f32(x), f32(y)) * texel,
        i32(cascade),
        projected.z - bias
      );
    }
  }
  let edge = f32(pcfRadius * 2 + 1);
  return visibility / (edge * edge);
}

fn localShadowVisibility(lightIndex: u32, worldPosition: vec3<f32>, normal: vec3<f32>, lightDirection: vec3<f32>) -> f32 {
  let count = min(localShadowReceiverData.words[0].x, 16u);
  for (var record = 0u; record < count; record += 1u) {
    let base = 1u + record * 5u;
    let metadata = localShadowReceiverData.words[base];
    if (metadata.x != lightIndex) { continue; }
    let bias = 0.0005 + 0.002 * (1.0 - clamp(dot(normal, lightDirection), 0.0, 1.0));
    if (metadata.y == 1u) {
      let lightBase = 4u + lightIndex * 16u;
      let lightPosition = vec3<f32>(bitcast<f32>(lightWord(lightBase + 4u)), bitcast<f32>(lightWord(lightBase + 5u)), bitcast<f32>(lightWord(lightBase + 6u)));
      let direction = worldPosition - lightPosition;
      let absolute = abs(direction);
      var face = 0u;
      var sc = -direction.z;
      var tc = -direction.y;
      var signedMajor = direction.x;
      if (absolute.y >= absolute.x && absolute.y >= absolute.z) {
        face = select(3u, 2u, direction.y >= 0.0);
        sc = direction.x;
        tc = select(-direction.z, direction.z, direction.y >= 0.0);
        signedMajor = direction.y;
      } else if (absolute.z >= absolute.x && absolute.z >= absolute.y) {
        face = select(5u, 4u, direction.z >= 0.0);
        sc = direction.x;
        tc = -direction.y;
        signedMajor = direction.z;
      } else if (direction.x < 0.0) {
        face = 1u;
        sc = direction.z;
      }
      let near = bitcast<f32>(localShadowReceiverData.words[base + 1u].x);
      let far = bitcast<f32>(localShadowReceiverData.words[base + 1u].y);
      let distanceToLight = length(direction);
      if (abs(signedMajor) <= 0.000001 || distanceToLight < near || distanceToLight > far) { return 1.0; }
      let uv = vec2<f32>(sc / abs(signedMajor), tc / abs(signedMajor)) * 0.5 + vec2<f32>(0.5);
      let depth = far / (far - near) - far * near / ((far - near) * distanceToLight);
      return textureSampleCompareLevel(directionalShadowMap, directionalShadowSampler, uv, i32(metadata.z + face), depth - bias);
    }
    let clip = mat4x4<f32>(
      bitcast<vec4<f32>>(localShadowReceiverData.words[base + 1u]),
      bitcast<vec4<f32>>(localShadowReceiverData.words[base + 2u]),
      bitcast<vec4<f32>>(localShadowReceiverData.words[base + 3u]),
      bitcast<vec4<f32>>(localShadowReceiverData.words[base + 4u])
    ) * vec4<f32>(worldPosition, 1.0);
    let projected = clip.xyz / clip.w;
    let uv = projected.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
    if (projected.z < 0.0 || projected.z > 1.0 || any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) { return 1.0; }
    return textureSampleCompareLevel(directionalShadowMap, directionalShadowSampler, uv, i32(metadata.z), projected.z - bias);
  }
  return 1.0;
}
