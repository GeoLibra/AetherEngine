// ============================================================================
// AetherEngine Shared Shader Module - Surface Coverage
// Pure alpha testing and silhouette coverage evaluation predicate.
// ============================================================================

/// Evaluates whether a surface fragment passes the alpha cutoff test.
///
/// Parameters:
/// - `alpha`: Sampled and factor-modulated surface alpha in [0.0, 1.0].
/// - `alphaCutoff`: Threshold value below which fragments are discarded.
/// - `alphaMask`: Flag indicating if alpha masking/cutoff is active (non-zero = active).
///
/// Returns:
/// `true` if the fragment survives the alpha test (keep), `false` if it should be discarded.
fn evaluateAlphaCoverage(alpha: f32, alphaCutoff: f32, alphaMask: u32) -> bool {
  if (alphaMask != 0u && alpha < alphaCutoff) {
    return false;
  }
  return true;
}
