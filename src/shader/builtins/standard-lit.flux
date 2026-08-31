struct ObjectData {
  world: mat4x4<f32>,
};

struct ViewData {
  viewProjection: mat4x4<f32>,
};

struct MaterialData {
  baseColor: vec4<f32>,
  metallic: f32,
  roughness: f32,
};

struct DirectionalLightData {
  direction: vec3<f32>,
  illuminance: f32,
  color: vec3<f32>,
};

struct StandardLitVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) normal: vec3<f32>,
};

struct StandardLitFragmentInput {
  @location(0) normal: vec3<f32>,
};

@group(0) @binding(0) var<uniform> objectData: ObjectData;
@group(1) @binding(0) var<uniform> viewData: ViewData;
@group(2) @binding(0) var<uniform> materialData: MaterialData;
@group(3) @binding(0) var<uniform> lightData: DirectionalLightData;

@vertex
fn standardLitVertex(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>
) -> StandardLitVertexOutput {
  let worldPosition = objectData.world * vec4<f32>(position, 1.0);
  let worldNormal = normalize((objectData.world * vec4<f32>(normal, 0.0)).xyz);
  return StandardLitVertexOutput(viewData.viewProjection * worldPosition, worldNormal);
}

@fragment
fn standardLitFragment(
  fragmentInput: StandardLitFragmentInput
) -> @location(0) vec4<f32> {
  let lambert = max(
    dot(normalize(fragmentInput.normal), -normalize(lightData.direction)),
    0.0
  );
  let factor = 0.15 + 0.85 * lambert;
  let lit = materialData.baseColor.rgb * lightData.color * factor;
  return vec4<f32>(lit, materialData.baseColor.a);
}
