struct VertexOut {
  @builtin(position) position: vec4<f32>,
};

@vertex
fn vertexAlpha(@location(0) position: vec3<f32>) -> VertexOut {
  var output: VertexOut;
  output.position = vec4<f32>(position, 1.0);
  return output;
}

@vertex
fn vertexBeta(@location(0) position: vec3<f32>) -> VertexOut {
  var output: VertexOut;
  output.position = vec4<f32>(position.xy, 0.0, 1.0);
  return output;
}

@fragment
fn fragmentMain() -> @location(0) vec4<f32> {
  return vec4<f32>(0.25, 0.5, 0.75, 1.0);
}

@compute @workgroup_size(1)
fn computeMain() {}
