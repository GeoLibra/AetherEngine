fn faultyFunction() -> f32 {
  // Line 2: intentional type mismatch to trigger Naga validation error
  let badVal: vec3<f32> = 123.45;
  return 0.0;
}
