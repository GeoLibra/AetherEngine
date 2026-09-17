// ============================================================================
// AetherEngine Shared Shader Module - Equirectangular Spherical Projection
// Converts 3D Cartesian direction vectors to 2D equirectangular spherical UVs.
// ============================================================================

const EQUIR_PI: f32 = 3.141592653589793;
const EQUIR_TWO_PI: f32 = 6.283185307179586;

/// Converts a 3D unit direction vector to 2D equirectangular spherical coordinates [0.0, 1.0].
///
/// Parameters:
/// - `direction`: 3D direction vector (will be normalized internally).
///
/// Returns:
/// 2D UV coordinate pair in [0.0, 1.0] where U corresponds to azimuthal angle (longitude)
/// and V corresponds to polar angle from +Y (latitude).
fn directionToEquirectangularUv(direction: vec3<f32>) -> vec2<f32> {
  let normalized = normalize(direction);
  var u = atan2(normalized.z, normalized.x) / EQUIR_TWO_PI + 0.5;
  u = fract(u);
  let v = acos(clamp(normalized.y, -1.0, 1.0)) / EQUIR_PI;
  return vec2<f32>(u, v);
}
