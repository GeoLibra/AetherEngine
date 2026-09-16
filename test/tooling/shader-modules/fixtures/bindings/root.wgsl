#import "./params.wgsl"
@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return materialParams.baseColor * materialParams.roughness;
}
