// ============================================================================
// AetherEngine Shared Shader Module - Fullscreen Triangle
// Generates a single clip-space triangle covering the full viewport NDC [-1, 1]
// using 3 vertex indices (0, 1, 2) without vertex buffer uploads.
// ============================================================================

/// Output structure for full-screen rasterization passes.
struct FullscreenVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

/// Computes the 4D homogeneous clip-space position for a full-screen triangle vertex.
///
/// Parameters:
/// - `vertexIndex`: Built-in vertex index (@builtin(vertex_index) index: u32).
///
/// Returns:
/// Projected clip-space coordinate with Z = 0.0, W = 1.0.
fn fullscreenClipPosition(vertexIndex: u32) -> vec4<f32> {
  let x = f32((vertexIndex << 1u) & 2u);
  let y = f32(vertexIndex & 2u);
  return vec4<f32>(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
}

/// Computes the 2D texture coordinate in [0.0, 1.0] for a full-screen triangle vertex.
///
/// Parameters:
/// - `vertexIndex`: Built-in vertex index (@builtin(vertex_index) index: u32).
///
/// Returns:
/// 2D UV coordinate where (0, 0) is top-left and (1, 1) is bottom-right.
fn fullscreenUv(vertexIndex: u32) -> vec2<f32> {
  let x = f32((vertexIndex << 1u) & 2u);
  let y = f32(vertexIndex & 2u);
  return vec2<f32>(x, 1.0 - y);
}

/// Generates complete clip-space position and texture coordinates for a full-screen pass.
///
/// Parameters:
/// - `vertexIndex`: Built-in vertex index (@builtin(vertex_index) index: u32).
///
/// Returns:
/// Populated FullscreenVertexOutput.
fn generateFullscreenVertex(vertexIndex: u32) -> FullscreenVertexOutput {
  return FullscreenVertexOutput(
    fullscreenClipPosition(vertexIndex),
    fullscreenUv(vertexIndex)
  );
}
