// ============================================================================
// AetherEngine Standard PBR Shader (Metallic-Roughness Workflow)
// Cook-Torrance microfacet specular BRDF + Lambertian diffuse direct lighting.
// Shared shading logic: per-draw, per-view, and light loop evaluation.
// Surface sampling, IBL, and shadow receiver functions are imported from modules.
// ============================================================================

// ----------------------------------------------------------------------------
// Uniform Buffer Data Structures (UBO)
// ----------------------------------------------------------------------------

/// Per-draw object transform matrices in world space.
struct ObjectData {
  world: mat4x4<f32>,
  normalWorld: mat4x4<f32>,
  receiver: u32,
};

/// Per-view camera matrices and world-space position (16-byte aligned).
struct ViewData {
  viewProjection: mat4x4<f32>, // 64 bytes
  view: mat4x4<f32>,           // 64 bytes; world-to-camera transform for cluster depth selection
  cameraPosition: vec3<f32>,   // 12 bytes, alignment 16
};

struct ReceiverLightHeader { offset: u32, count: u32 };

// ----------------------------------------------------------------------------
// Stage Input / Output Interfaces
// ----------------------------------------------------------------------------

/// Output from vertex shader passed to the rasterizer and fragment shader.
struct StandardLitVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) worldPosition: vec3<f32>,
  @location(2) uv0: vec2<f32>,
  @location(3) uv1: vec2<f32>,
  @location(4) tangent: vec4<f32>,
  @location(5) color: vec4<f32>,
};

// ----------------------------------------------------------------------------
// Shared Resource Bindings
// ----------------------------------------------------------------------------

@group(0) @binding(0) var<uniform> objectData: ObjectData;               // Group 0: Per-draw
@group(1) @binding(0) var<uniform> viewData: ViewData;                   // Group 1: Per-view / Per-frame

// Group 2 bindings 0..6 (materialData, textures, surfaceSampler) and StandardLitSurface
// are declared in imported module: surface/standard.wgsl.

// Group 3 bindings 5..9 (environment) and 10..12 (shadow) are declared in
// imported modules: lighting/ibl.wgsl and lighting/shadow-receiver.wgsl.

// ----------------------------------------------------------------------------
// Direct Light Evaluation
// ----------------------------------------------------------------------------

fn evaluatePackedLight(
  index: u32,
  worldPosition: vec3<f32>,
  normal: vec3<f32>,
  viewDirection: vec3<f32>,
  surface: StandardLitSurface
) -> vec3<f32> {
  let base = 4u + index * 16u;
  let vector = vec3<f32>(
    bitcast<f32>(lightWord(base + 4u)),
    bitcast<f32>(lightWord(base + 5u)),
    bitcast<f32>(lightWord(base + 6u))
  );
  let color = vec3<f32>(
    bitcast<f32>(lightWord(base + 8u)),
    bitcast<f32>(lightWord(base + 9u)),
    bitcast<f32>(lightWord(base + 10u))
  );
  let intensity = bitcast<f32>(lightWord(base + 11u));
  if (lightWord(base) == 0u) {
    let lightDirection = -normalize(vector);
    let visibility = directionalShadowVisibility(index, worldPosition, normal, lightDirection);
    return cookTorranceDirect(
      normal,
      viewDirection,
      lightDirection,
      surface.baseColor.rgb,
      surface.metallic,
      surface.roughness,
      color * intensity
    ) * visibility;
  }
  let delta = vector - worldPosition;
  let distanceSquared = max(dot(delta, delta), 0.000001);
  let lightDirection = normalize(delta);
  if (lightWord(base) == 2u) {
    let spotAxis = normalize(vec3<f32>(
      bitcast<f32>(lightWord(base + 12u)),
      bitcast<f32>(lightWord(base + 13u)),
      bitcast<f32>(lightWord(base + 14u))
    ));
    let coneCosine = dot(normalize(worldPosition - vector), spotAxis);
    if (coneCosine < cos(bitcast<f32>(lightWord(base + 15u)))) {
      return vec3<f32>(0.0);
    }
  }
  return cookTorranceDirect(
    normal,
    viewDirection,
    lightDirection,
    surface.baseColor.rgb,
    surface.metallic,
    surface.roughness,
    color * intensity / distanceSquared
  ) * localShadowVisibility(index, worldPosition, normal, lightDirection);
}

// ----------------------------------------------------------------------------
// Image-Based Lighting Facade
// ----------------------------------------------------------------------------

/// Evaluates image-based lighting for a StandardLitSurface by unpacking surface
/// properties and delegating to the shared evaluateIbl module function.
fn evaluateSurfaceIbl(
  normal: vec3<f32>,
  viewDirection: vec3<f32>,
  surface: StandardLitSurface
) -> vec3<f32> {
  return evaluateIbl(
    normal,
    viewDirection,
    surface.baseColor.rgb,
    surface.metallic,
    surface.roughness,
    surface.occlusion
  );
}
