// ============================================================================
// AetherEngine Standard PBR Shader (Metallic-Roughness Workflow)
// Cook-Torrance microfacet specular BRDF + Lambertian diffuse direct lighting.
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

/// Per-material PBR surface parameters.
/// - baseColor: Linear sRGB color with alpha.
/// - metallic: Normalized [0.0 = dielectric, 1.0 = pure metal].
/// - roughness: Normalized perceptual roughness [0.0 = mirror smooth, 1.0 = completely rough].
struct MaterialData {
  baseColor: vec4<f32>,
  emissiveFactor: vec3<f32>,
  normalScale: f32,
  metallic: f32,
  roughness: f32,
  occlusionStrength: f32,
  alphaCutoff: f32,
  baseColorUvSet: u32,
  metallicRoughnessUvSet: u32,
  normalUvSet: u32,
  occlusionUvSet: u32,
  emissiveUvSet: u32,
  alphaMask: u32,
  baseColorTransform: vec4<f32>,
  baseColorOffset: vec2<f32>,
  metallicRoughnessTransform: vec4<f32>,
  metallicRoughnessOffset: vec2<f32>,
  normalTransform: vec4<f32>,
  normalOffset: vec2<f32>,
  occlusionTransform: vec4<f32>,
  occlusionOffset: vec2<f32>,
  emissiveTransform: vec4<f32>,
  emissiveOffset: vec2<f32>,
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

/// Interpolated fragment input in world coordinate space.
struct StandardLitFragmentInput {
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
@group(2) @binding(0) var<uniform> materialData: MaterialData;           // Group 2: Per-material
@group(2) @binding(1) var baseColorTexture: texture_2d<f32>;
@group(2) @binding(2) var metallicRoughnessTexture: texture_2d<f32>;
@group(2) @binding(3) var normalTexture: texture_2d<f32>;
@group(2) @binding(4) var occlusionTexture: texture_2d<f32>;
@group(2) @binding(5) var emissiveTexture: texture_2d<f32>;
@group(2) @binding(6) var surfaceSampler: sampler;
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

fn selectUv(index: u32, uv0: vec2<f32>, uv1: vec2<f32>) -> vec2<f32> {
  return select(uv0, uv1, index == 1u);
}



// ----------------------------------------------------------------------------
// Fragment Shader Stage
// ----------------------------------------------------------------------------

@fragment
fn standardLitFragment(
  fragmentInput: StandardLitFragmentInput,
  @builtin(front_facing) frontFacing: bool
) -> @location(0) vec4<f32> {
  let bcUv = transformUv(
    selectUv(materialData.baseColorUvSet, fragmentInput.uv0, fragmentInput.uv1),
    materialData.baseColorTransform,
    materialData.baseColorOffset
  );
  let mrUv = transformUv(
    selectUv(materialData.metallicRoughnessUvSet, fragmentInput.uv0, fragmentInput.uv1),
    materialData.metallicRoughnessTransform,
    materialData.metallicRoughnessOffset
  );
  let normUv = transformUv(
    selectUv(materialData.normalUvSet, fragmentInput.uv0, fragmentInput.uv1),
    materialData.normalTransform,
    materialData.normalOffset
  );
  let occUv = transformUv(
    selectUv(materialData.occlusionUvSet, fragmentInput.uv0, fragmentInput.uv1),
    materialData.occlusionTransform,
    materialData.occlusionOffset
  );
  let emUv = transformUv(
    selectUv(materialData.emissiveUvSet, fragmentInput.uv0, fragmentInput.uv1),
    materialData.emissiveTransform,
    materialData.emissiveOffset
  );

  let baseSample = textureSample(baseColorTexture, surfaceSampler, bcUv);
  let mrSample = textureSample(metallicRoughnessTexture, surfaceSampler, mrUv);
  let normalSample = textureSample(normalTexture, surfaceSampler, normUv).xyz * 2.0 - vec3<f32>(1.0);
  let emissive = materialData.emissiveFactor * textureSample(emissiveTexture, surfaceSampler, emUv).rgb;
  let aoSample = textureSample(occlusionTexture, surfaceSampler, occUv).r;
  let ao = 1.0 + materialData.occlusionStrength * (aoSample - 1.0);
  let baseColor = materialData.baseColor * baseSample * fragmentInput.color;
  if (!evaluateAlphaCoverage(baseColor.a, materialData.alphaCutoff, materialData.alphaMask)) {
    discard;
  }

  let rawNormal = normalize(fragmentInput.normal);
  let geometricNormal = select(-rawNormal, rawNormal, frontFacing);
  let tangent = normalize(fragmentInput.tangent.xyz);
  let bitangent = cross(geometricNormal, tangent) * fragmentInput.tangent.w;
  let mapped = normalize(vec3<f32>(normalSample.xy * materialData.normalScale, normalSample.z));
  let normal = normalize(tangent * mapped.x + bitangent * mapped.y + geometricNormal * mapped.z);
  let lightDirection = -normalize(lightData.direction);
  let viewDirection = normalize(viewData.cameraPosition - fragmentInput.worldPosition);

  let lit = cookTorranceDirect(
    normal,
    viewDirection,
    lightDirection,
    baseColor.rgb,
    materialData.metallic * mrSample.b,
    materialData.roughness * mrSample.g,
    lightData.color
  );

  // In glTF PBR specification, ambient occlusion strictly modulates indirect diffuse/ambient light.
  // Direct sunlight (lit) must not be multiplied by ao.
  let indirectDiffuse = vec3<f32>(0.0);
  let ambient = indirectDiffuse * ao;
  return vec4<f32>(lit + ambient + emissive, baseColor.a);
}
