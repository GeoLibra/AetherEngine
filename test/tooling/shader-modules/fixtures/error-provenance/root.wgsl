#import "./leaf_with_error.wgsl"
@fragment
fn fs_main() -> @location(0) vec4<f32> {
  let v = faultyFunction();
  return vec4<f32>(v, 0.0, 0.0, 1.0);
}
