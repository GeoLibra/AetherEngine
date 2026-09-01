struct NestedMaterial {
    tint: vec4<f32>,
}

struct SceneUniforms {
    transform: mat4x4<f32>,
    material: NestedMaterial,
}

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) uv: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@group(1) @binding(3)
var shadowSampler: sampler_comparison;

@group(1) @binding(1)
var depthTexture: texture_depth_2d;

@group(0) @binding(1)
var<storage, read> offsets: array<vec4<f32>>;

@group(1) @binding(2)
var colorSampler: sampler;

@group(0) @binding(0)
var<uniform> scene: SceneUniforms;

@group(1) @binding(0)
var colorTexture: texture_2d<f32>;

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let color = textureSample(colorTexture, colorSampler, input.uv);
    let shadow = textureSampleCompare(depthTexture, shadowSampler, input.uv, 0.5);
    return color * shadow;
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = scene.transform * vec4<f32>(input.position, 1.0) + offsets[0];
    output.uv = input.uv;
    return output;
}
