struct SceneUniforms {
    modelViewProjection: mat4x4<f32>,
};

@group(0) @binding(0)
var<uniform> scene: SceneUniforms;

@vertex
fn vertexMain(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
    return scene.modelViewProjection * vec4<f32>(position, 1.0);
}

@fragment
fn fragmentMain() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0, 0.0, 0.0, 1.0);
}
