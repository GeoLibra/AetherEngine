// ============================================================================
// AetherEngine Shared Shader Module - Geometric Intersection Tests
// Pure analytical bounding tests for sphere-sphere and sphere-AABB proximity.
// ============================================================================

/// Tests distance squared between two spheres.
///
/// Parameters:
/// - `posA`: Center of sphere A.
/// - `radiusA`: Radius of sphere A.
/// - `posB`: Center of sphere B.
/// - `radiusB`: Radius of sphere B.
///
/// Returns:
/// Distance squared minus combined radius squared. <= 0.0 indicates intersection.
fn distanceSquaredSphereToSphere(
  posA: vec3<f32>,
  radiusA: f32,
  posB: vec3<f32>,
  radiusB: f32
) -> f32 {
  let delta = posA - posB;
  let combinedRadius = radiusA + radiusB;
  return dot(delta, delta) - combinedRadius * combinedRadius;
}

/// Tests distance squared between a sphere and an axis-aligned bounding box (AABB).
///
/// Parameters:
/// - `sphereCenter`: Center of the sphere.
/// - `sphereRadius`: Radius of the sphere.
/// - `boxMin`: Minimum coordinates of the AABB.
/// - `boxMax`: Maximum coordinates of the AABB.
///
/// Returns:
/// Distance squared to closest box point minus radius squared. <= 0.0 indicates intersection.
fn distanceSquaredSphereToAabb(
  sphereCenter: vec3<f32>,
  sphereRadius: f32,
  boxMin: vec3<f32>,
  boxMax: vec3<f32>
) -> f32 {
  let closest = clamp(sphereCenter, boxMin, boxMax);
  let delta = sphereCenter - closest;
  return dot(delta, delta) - sphereRadius * sphereRadius;
}
