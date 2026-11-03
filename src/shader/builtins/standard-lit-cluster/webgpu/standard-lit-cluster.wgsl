// ============================================================================
// AetherEngine Standard PBR Shader - WebGPU Clustered Forward Entry
// ============================================================================

@vertex
fn standardLitVertex(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv0: vec2<f32>,
  @location(3) uv1: vec2<f32>,
  @location(4) tangent: vec4<f32>,
  @location(5) color0: vec4<f32>
) -> StandardLitVertexOutput {
  let worldPosition = objectData.world * vec4<f32>(position, 1.0);
  let worldNormal = normalize((objectData.normalWorld * vec4<f32>(normal, 0.0)).xyz);
  let rawWorldTangent = (objectData.world * vec4<f32>(tangent.xyz, 0.0)).xyz;
  let worldTangent = normalize(rawWorldTangent - worldNormal * dot(worldNormal, rawWorldTangent));
  let world3 = mat3x3<f32>(objectData.world[0].xyz, objectData.world[1].xyz, objectData.world[2].xyz);
  let transformSign = select(-1.0, 1.0, determinant(world3) >= 0.0);
  return StandardLitVertexOutput(
    viewData.viewProjection * worldPosition, worldNormal, worldPosition.xyz, uv0, uv1,
    vec4<f32>(worldTangent, tangent.w * transformSign), color0
  );
}

@fragment
fn standardLitFragment(
  fragmentInput: StandardLitFragmentInput,
  @builtin(position) fragmentPosition: vec4<f32>,
  @builtin(front_facing) frontFacing: bool
) -> @location(0) vec4<f32> {
  let surface = sampleStandardLitSurface(fragmentInput, frontFacing);
  if (!evaluateAlphaCoverage(surface.baseColor.a, materialData.alphaCutoff, materialData.alphaMask)) { discard; }
  let normal = surface.normal;
  let viewDirection = normalize(viewData.cameraPosition - fragmentInput.worldPosition);
  var lit = evaluateSurfaceIbl(normal, viewDirection, surface);
  for (var index = 0u; index < directionalLightCount(); index += 1u) {
    lit += evaluatePackedLight(directionalIndex(index), fragmentInput.worldPosition, normal, viewDirection, surface);
  }
  let header = selectClusterHeader(fragmentPosition, fragmentInput.worldPosition);
  for (var index = 0u; index < header.count; index += 1u) {
    let wordIndex = header.offset + index;
    lit += evaluatePackedLight(indexWords.values[wordIndex / 4u][wordIndex % 4u], fragmentInput.worldPosition, normal, viewDirection, surface);
  }
  return vec4<f32>(lit + surface.emissive, surface.baseColor.a);
}
