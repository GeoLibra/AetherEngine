// ============================================================================
// AetherEngine Standard PBR Shader (Metallic-Roughness Workflow)
// Cook-Torrance microfacet specular BRDF + Lambertian diffuse direct lighting.
// Per-draw, per-view, and single directional light pass entry point.
// Surface sampling and BRDF functions are imported from shared shader modules.
// ============================================================================

// ----------------------------------------------------------------------------
// Uniform Buffer Data Structures (UBO)
// ----------------------------------------------------------------------------

/// Per-draw object transform matrices in world space.
struct ObjectData {
  world: mat4x4<f32>,
  normalWorld: mat4x4<f32>,
};

/// Per-view camera matrices and world-space position (16-byte aligned).
struct ViewData {
  viewProjection: mat4x4<f32>, // 64 bytes
  cameraPosition: vec3<f32>,   // 12 bytes, alignment 16
};

/// Directional light source parameters.
/// - direction: Normalized direction vector pointing from surface to light (or light heading).
/// - illuminance: Reserved for HDR physically-based lighting; intentionally unused by current LDR baseline.
/// - color: Linear light color (rgb).
struct DirectionalLightData {
  direction: vec3<f32>,
  // Reserved for HDR physically-based lighting; intentionally unused by current LDR baseline.
  illuminance: f32,
  color: vec3<f32>,
};

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
// Resource Bindings (Organized by Update Frequency)
// ----------------------------------------------------------------------------

@group(0) @binding(0) var<uniform> objectData: ObjectData;               // Group 0: Per-draw
@group(1) @binding(0) var<uniform> viewData: ViewData;                   // Group 1: Per-view / Per-frame
// Group 2 bindings 0..6 (materialData, textures, surfaceSampler) are declared in surface/standard.wgsl
@group(3) @binding(0) var<uniform> lightData: DirectionalLightData;       // Group 3: Per-scene / Per-light

// ----------------------------------------------------------------------------
// Vertex Shader Stage
// ----------------------------------------------------------------------------

@vertex
fn standardLitVertex(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv0: vec2<f32>,
  @location(3) uv1: vec2<f32>,
  @location(4) tangent: vec4<f32>,
  @location(5) color0: vec4<f32>
) -> StandardLitVertexOutput {
  // Transform vertex position to world space
  let worldPosition = objectData.world * vec4<f32>(position, 1.0);

  // Transform normal vector to world space via normal matrix
  let worldNormal = normalize((objectData.normalWorld * vec4<f32>(normal, 0.0)).xyz);
  let rawWorldTangent = (objectData.world * vec4<f32>(tangent.xyz, 0.0)).xyz;
  let worldTangent = normalize(rawWorldTangent - worldNormal * dot(worldNormal, rawWorldTangent));
  let world3 = mat3x3<f32>(objectData.world[0].xyz, objectData.world[1].xyz, objectData.world[2].xyz);
  let transformSign = select(-1.0, 1.0, determinant(world3) >= 0.0);

  return StandardLitVertexOutput(
    viewData.viewProjection * worldPosition, // Projected clip position
    worldNormal,                             // World normal for fragment shading
    worldPosition.xyz,
    uv0,
    uv1,
    vec4<f32>(worldTangent, tangent.w * transformSign),
    color0
  );
}

// ----------------------------------------------------------------------------
// Fragment Shader Stage
// ----------------------------------------------------------------------------

@fragment
fn standardLitFragment(
  fragmentInput: StandardLitFragmentInput,
  @builtin(front_facing) frontFacing: bool
) -> @location(0) vec4<f32> {
  let surface = sampleStandardLitSurface(fragmentInput, frontFacing);
  if (!evaluateAlphaCoverage(surface.baseColor.a, materialData.alphaCutoff, materialData.alphaMask)) {
    discard;
  }

  let lightDirection = -normalize(lightData.direction);
  let viewDirection = normalize(viewData.cameraPosition - fragmentInput.worldPosition);

  let lit = cookTorranceDirect(
    surface.normal,
    viewDirection,
    lightDirection,
    surface.baseColor.rgb,
    surface.metallic,
    surface.roughness,
    lightData.color
  );

  // In glTF PBR specification, ambient occlusion strictly modulates indirect diffuse/ambient light.
  // Direct sunlight (lit) must not be multiplied by ao.
  let indirectDiffuse = vec3<f32>(0.0);
  let ambient = indirectDiffuse * surface.occlusion;
  return vec4<f32>(lit + ambient + surface.emissive, surface.baseColor.a);
}
