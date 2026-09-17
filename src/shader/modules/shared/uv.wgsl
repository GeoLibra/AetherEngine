// ============================================================================
// AetherEngine Shared Shader Module - UV Operations
// Pure 2D texture coordinate affine transformations and UV set selection.
// ============================================================================

/// Transforms a 2D texture coordinate `(u, v)` via a 2x2 affine matrix and translation offset:
///   u' = matrix.x * uv.x + matrix.y * uv.y + offset.x
///   v' = matrix.z * uv.x + matrix.w * uv.y + offset.y
///
/// Coordinate space: Normalized UV space [0.0, 1.0].
///
/// Parameters:
/// - `uv`: Raw authored 2D texture coordinate from vertex attribute.
/// - `matrix`: 2x2 affine transform matrix components (scale and rotation) packed as `(m00, m01, m10, m11)`.
/// - `offset`: 2D translation offset `(tx, ty)`.
///
/// Returns:
/// Transformed 2D texture coordinate vector.
fn transformUv(uv: vec2<f32>, matrix: vec4<f32>, offset: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(
    matrix.x * uv.x + matrix.y * uv.y + offset.x,
    matrix.z * uv.x + matrix.w * uv.y + offset.y
  );
}
