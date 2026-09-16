const PI: f32 = 3.14159265359;

fn distributionGgx(nDotH: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let d = (nDotH * a2 - nDotH) * nDotH + 1.0;
  return a2 / (PI * d * d);
}
