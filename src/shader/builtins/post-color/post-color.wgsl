struct PostColorData {
  exposure: f32,
};

@group(0) @binding(0) var sceneColor: texture_2d<f32>;
@group(0) @binding(1) var sceneSampler: sampler;
@group(1) @binding(0) var<uniform> postColor: PostColorData;

@vertex
fn postColorVertex(@builtin(vertex_index) index: u32) -> FullscreenVertexOutput {
  return generateFullscreenVertex(index);
}

@fragment
fn postColorFragment(input: FullscreenVertexOutput) -> @location(0) vec4<f32> {
  let sceneLinear = textureSample(sceneColor, sceneSampler, input.uv).rgb;
  return vec4<f32>(acesFitted(sceneLinear * postColor.exposure), 1.0);
}
