struct SkyboxUniforms {
  ray0: vec4<f32>,
  ray1: vec4<f32>,
  ray2: vec4<f32>,
  radianceTint: vec4<f32>,
  invProj: mat4x4<f32>,
  envRot: mat4x4<f32>,
  params: vec4<f32>,
  flags: vec4<f32>,
  solidColor: vec4<f32>,
};

@group(0) @binding(0) var<uniform> skyboxUniforms: SkyboxUniforms;
@group(1) @binding(0) var skyTexture: texture_2d<f32>;
@group(1) @binding(1) var skySampler: sampler;

struct FullscreenOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) direction: vec3<f32>,
  @location(1) ndc: vec2<f32>,
};

@vertex
fn skyboxVertex(@builtin(vertex_index) index: u32) -> FullscreenOutput {
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);
  let clipPos = vec4<f32>(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);

  var dir = skyboxUniforms.ray0.xyz;
  if (index == 1u) {
    dir = skyboxUniforms.ray1.xyz;
  } else if (index == 2u) {
    dir = skyboxUniforms.ray2.xyz;
  }

  return FullscreenOutput(
    clipPos,
    dir,
    clipPos.xy
  );
}

fn reconstructFragmentRay(ndc: vec2<f32>) -> vec3<f32> {
  if (skyboxUniforms.flags.w > 0.5) {
    let d = (skyboxUniforms.envRot * vec4<f32>(0.0, 0.0, -1.0, 0.0)).xyz;
    return normalize(d);
  }
  let zNear = skyboxUniforms.flags.z;
  let clip = vec4<f32>(ndc.x, ndc.y, zNear, 1.0);
  let viewRayH = skyboxUniforms.invProj * clip;
  let unnormalizedView = viewRayH.xyz / viewRayH.w;
  let worldRay = (skyboxUniforms.envRot * vec4<f32>(unnormalizedView, 0.0)).xyz;
  return normalize(worldRay);
}

@fragment
fn skyboxFragment(input: FullscreenOutput) -> @location(0) vec4<f32> {
  if (skyboxUniforms.flags.y > 1.5) {
    return vec4<f32>(skyboxUniforms.solidColor.rgb, 1.0);
  }

  var dir: vec3<f32>;
  if (skyboxUniforms.flags.x > 0.5) {
    dir = reconstructFragmentRay(input.ndc);
  } else {
    dir = normalize(input.direction);
  }

  let uv = directionToEquirectangularUv(dir);

  var lod: f32 = 0.0;
  if (skyboxUniforms.flags.y > 0.5) {
    lod = 0.0;
  } else {
    let dDdx = dpdx(dir);
    let dDdy = dpdy(dir);

    let dirX = normalize(dir + dDdx);
    let dirY = normalize(dir + dDdy);

    let uvX = directionToEquirectangularUv(dirX);
    let uvY = directionToEquirectangularUv(dirY);

    var du_dx = uvX.x - uv.x;
    var du_dy = uvY.x - uv.x;

    if (du_dx > 0.5) {
      du_dx -= 1.0;
    } else if (du_dx < -0.5) {
      du_dx += 1.0;
    }

    if (du_dy > 0.5) {
      du_dy -= 1.0;
    } else if (du_dy < -0.5) {
      du_dy += 1.0;
    }

    let dv_dx = uvX.y - uv.y;
    let dv_dy = uvY.y - uv.y;

    let texSize = vec2<f32>(skyboxUniforms.params.z, skyboxUniforms.params.w);
    let dxTexels = vec2<f32>(du_dx, dv_dx) * texSize;
    let dyTexels = vec2<f32>(du_dy, dv_dy) * texSize;

    let rho = max(max(length(dxTexels), length(dyTexels)), 1.0);
    let maxLod = skyboxUniforms.params.y;
    lod = clamp(log2(rho), 0.0, maxLod);

    if (1.0 - abs(dir.y) <= 0.000001) {
      lod = maxLod;
    }
  }

  let sampled = textureSampleLevel(skyTexture, skySampler, uv, lod).rgb;
  let radiance = sampled * skyboxUniforms.params.x * skyboxUniforms.radianceTint.rgb;
  return vec4<f32>(radiance, 1.0);
}
