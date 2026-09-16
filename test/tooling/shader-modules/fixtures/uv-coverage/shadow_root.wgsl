#import "./coverage.wgsl"
@fragment
fn fs_main() {
  let uv = transformUv(vec2<f32>(0.5, 0.5), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 0.0));
  if (!testAlphaCoverage(uv.x, 0.33)) {
    discard;
  }
}
