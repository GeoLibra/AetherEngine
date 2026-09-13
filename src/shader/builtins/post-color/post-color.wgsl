struct PostColorData {
  exposure: f32,
};

@group(0) @binding(0) var sceneColor: texture_2d<f32>;
@group(0) @binding(1) var sceneSampler: sampler;
@group(1) @binding(0) var<uniform> postColor: PostColorData;

struct FullscreenOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn postColorVertex(@builtin(vertex_index) index: u32) -> FullscreenOutput {
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);
  return FullscreenOutput(
    vec4<f32>(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0),
    vec2<f32>(x, 1.0 - y)
  );
}

fn acesFitted(color: vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((color * (a * color + vec3<f32>(b))) /
    (color * (c * color + vec3<f32>(d)) + vec3<f32>(e)), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn postColorFragment(input: FullscreenOutput) -> @location(0) vec4<f32> {
  let sceneLinear = textureSample(sceneColor, sceneSampler, input.uv).rgb;
  return vec4<f32>(acesFitted(sceneLinear * postColor.exposure), 1.0);
}
