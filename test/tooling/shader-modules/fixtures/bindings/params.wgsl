struct MaterialUniforms {
  baseColor: vec4<f32>,
  roughness: f32,
};

@group(1) @binding(0)
var<uniform> materialParams: MaterialUniforms;
