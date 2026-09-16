fn transformUv(uv: vec2<f32>, scale: vec2<f32>, offset: vec2<f32>) -> vec2<f32> {
  return uv * scale + offset;
}
