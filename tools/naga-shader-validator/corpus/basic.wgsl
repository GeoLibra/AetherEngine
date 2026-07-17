struct VertexOut {
  @builtin(position) position: vec4<f32>,
};

@vertex
fn vertexMain(@location(0) position: vec3<f32>) -> VertexOut {
  var output: VertexOut;
  output.position = vec4<f32>(position, 1.0);
  return output;
}

@fragment
fn fragmentMain() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 0.5, 0.25, 1.0);
}
