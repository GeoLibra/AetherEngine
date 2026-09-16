// ============================================================================
// AetherEngine Shared Shader Module - Post-Processing Tone Mapping
// Photographic and display tone curve approximations.
// ============================================================================

/// ACES Fitted tone mapping curve (Stephen Hill / Narkowicz / ACES fit).
/// Maps high dynamic range linear RGB values [0.0, +inf) to display-referred [0.0, 1.0].
///
/// Parameters:
/// - `color`: Linear HDR RGB color vector.
///
/// Returns:
/// Tone-mapped linear display color clamped to [0.0, 1.0].
fn acesFitted(color: vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp(
    (color * (a * color + vec3<f32>(b))) /
    (color * (c * color + vec3<f32>(d)) + vec3<f32>(e)),
    vec3<f32>(0.0),
    vec3<f32>(1.0)
  );
}
