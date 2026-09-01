struct ObjectData {
  world: mat4x4<f32>,
  normalWorld: mat4x4<f32>,
};

struct ViewData {
  viewProjection: mat4x4<f32>,
  cameraPosition: vec3<f32>,
  padding: f32,
};

struct MaterialData {
  baseColor: vec4<f32>,
  metallic: f32,
  roughness: f32,
};

struct DirectionalLightData {
  direction: vec3<f32>,
  // Retained physical intent; baseline LDR shading uses normalized color until HDR exposure lands.
  illuminance: f32,
  color: vec3<f32>,
};

struct StandardLitVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) worldPosition: vec3<f32>,
};

struct StandardLitFragmentInput {
  @location(0) normal: vec3<f32>,
  @location(1) worldPosition: vec3<f32>,
};

@group(0) @binding(0) var<uniform> objectData: ObjectData;
@group(1) @binding(0) var<uniform> viewData: ViewData;
@group(2) @binding(0) var<uniform> materialData: MaterialData;
@group(3) @binding(0) var<uniform> lightData: DirectionalLightData;

fn fifthPower(value: f32) -> f32 {
  let squared = value * value;
  return squared * squared * value;
}

fn distributionGgx(normal: vec3<f32>, halfDirection: vec3<f32>, roughness: f32) -> f32 {
  let alpha = roughness * roughness;
  let alphaSquared = alpha * alpha;
  let normalDotHalf = max(dot(normal, halfDirection), 0.0);
  let denominator = normalDotHalf * normalDotHalf * (alphaSquared - 1.0) + 1.0;
  return alphaSquared / max(3.14159265359 * denominator * denominator, 0.000001);
}

fn geometrySchlickGgx(normalDotDirection: f32, roughness: f32) -> f32 {
  let shifted = roughness + 1.0;
  let k = shifted * shifted / 8.0;
  return normalDotDirection / max(normalDotDirection * (1.0 - k) + k, 0.000001);
}

fn geometrySmith(
  normal: vec3<f32>,
  viewDirection: vec3<f32>,
  lightDirection: vec3<f32>,
  roughness: f32
) -> f32 {
  let normalDotView = max(dot(normal, viewDirection), 0.0);
  let normalDotLight = max(dot(normal, lightDirection), 0.0);
  return geometrySchlickGgx(normalDotView, roughness) *
    geometrySchlickGgx(normalDotLight, roughness);
}

fn fresnelSchlick(cosine: f32, f0: vec3<f32>) -> vec3<f32> {
  return f0 + (vec3<f32>(1.0) - f0) * fifthPower(1.0 - cosine);
}

fn cookTorranceDirect(
  normal: vec3<f32>,
  viewDirection: vec3<f32>,
  lightDirection: vec3<f32>,
  baseColor: vec3<f32>,
  metallic: f32,
  roughness: f32,
  radiance: vec3<f32>
) -> vec3<f32> {
  let normalDotLight = max(dot(normal, lightDirection), 0.0);
  let normalDotView = max(dot(normal, viewDirection), 0.0);
  if (normalDotLight <= 0.0 || normalDotView <= 0.0) {
    return vec3<f32>(0.0);
  }
  let halfDirection = normalize(viewDirection + lightDirection);
  let clampedRoughness = max(roughness, 0.045);
  let distribution = distributionGgx(normal, halfDirection, clampedRoughness);
  let geometry = geometrySmith(normal, viewDirection, lightDirection, clampedRoughness);
  let f0 = vec3<f32>(0.04) * (1.0 - metallic) + baseColor * metallic;
  let fresnel = fresnelSchlick(max(dot(viewDirection, halfDirection), 0.0), f0);
  let diffuseWeight = (vec3<f32>(1.0) - fresnel) * (1.0 - metallic);
  let diffuse = diffuseWeight * baseColor / 3.14159265359;
  let specular = distribution * geometry * fresnel /
    max(4.0 * normalDotView * normalDotLight, 0.000001);
  return (diffuse + specular) * radiance * normalDotLight;
}

@vertex
fn standardLitVertex(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>
) -> StandardLitVertexOutput {
  let worldPosition = objectData.world * vec4<f32>(position, 1.0);
  let worldNormal = normalize((objectData.normalWorld * vec4<f32>(normal, 0.0)).xyz);
  return StandardLitVertexOutput(
    viewData.viewProjection * worldPosition,
    worldNormal,
    worldPosition.xyz
  );
}

@fragment
fn standardLitFragment(
  fragmentInput: StandardLitFragmentInput
) -> @location(0) vec4<f32> {
  let normal = normalize(fragmentInput.normal);
  let lightDirection = -normalize(lightData.direction);
  let viewDirection = normalize(viewData.cameraPosition - fragmentInput.worldPosition);
  let lit = cookTorranceDirect(
    normal,
    viewDirection,
    lightDirection,
    materialData.baseColor.rgb,
    materialData.metallic,
    materialData.roughness,
    lightData.color
  );
  return vec4<f32>(lit, materialData.baseColor.a);
}
