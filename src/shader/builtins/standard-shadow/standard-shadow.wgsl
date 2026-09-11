struct ShadowObjectData {
  world: mat4x4<f32>,
};

struct ShadowViewData {
  viewProjection: mat4x4<f32>,
};

struct ShadowMaterialData {
  baseColorFactor: vec4<f32>,
  alphaCutoff: f32,
  baseColorUvSet: u32,
  alphaMask: u32,
  padding: u32,
};

struct ShadowVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv0: vec2<f32>,
  @location(1) uv1: vec2<f32>,
};

@group(0) @binding(0) var<uniform> objectData: ShadowObjectData;
@group(1) @binding(0) var<uniform> shadowViewData: ShadowViewData;
@group(2) @binding(0) var<uniform> shadowMaterialData: ShadowMaterialData;
@group(2) @binding(1) var baseColorTexture: texture_2d<f32>;
@group(2) @binding(2) var surfaceSampler: sampler;

@vertex
fn standardShadowVertex(
  @location(0) position: vec3<f32>,
  @location(2) uv0: vec2<f32>,
  @location(3) uv1: vec2<f32>
) -> ShadowVertexOutput {
  let worldPosition = objectData.world * vec4<f32>(position, 1.0);
  return ShadowVertexOutput(shadowViewData.viewProjection * worldPosition, uv0, uv1);
}

@fragment
fn standardShadowFragment(input: ShadowVertexOutput) {
  let baseColorUv = select(input.uv0, input.uv1, shadowMaterialData.baseColorUvSet == 1u);
  let alpha = shadowMaterialData.baseColorFactor.a *
    textureSample(baseColorTexture, surfaceSampler, baseColorUv).a;
  if (shadowMaterialData.alphaMask != 0u && alpha < shadowMaterialData.alphaCutoff) { discard; }
}
