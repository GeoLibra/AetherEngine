struct SceneUniforms {
  transform: mat4x4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@group(0) @binding(0)
var<uniform> scene: SceneUniforms;

@group(1) @binding(0)
var colorTexture: texture_2d<f32>;

@group(1) @binding(1)
var colorSampler: sampler;

@vertex
fn vertexMain(
  @location(0) position: vec3<f32>,
  @location(1) uv: vec2<f32>,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = scene.transform * vec4<f32>(position, 1.0);
  output.uv = uv;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  return textureSample(colorTexture, colorSampler, input.uv);
}
