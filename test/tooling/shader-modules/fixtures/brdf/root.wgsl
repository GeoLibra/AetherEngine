#import "./brdf.wgsl"
@fragment
fn fs_main() -> @location(0) vec4<f32> {
  let d = distributionGgx(0.8, 0.25);
  return vec4<f32>(d, d, d, 1.0);
}
