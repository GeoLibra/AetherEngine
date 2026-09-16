#import "./b.wgsl"
#import "./c.wgsl"
@fragment
fn fs_main() -> @location(0) vec4<f32> {
  let val = getBValue() + getCValue();
  return vec4<f32>(val, 0.0, 0.0, 1.0);
}
