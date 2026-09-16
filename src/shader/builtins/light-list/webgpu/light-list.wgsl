struct PackedWords {
  values: array<u32>,
}

@group(0) @binding(0) var<storage, read> lights: PackedWords;
@group(0) @binding(1) var<storage, read> receivers: PackedWords;
@group(0) @binding(2) var<storage, read_write> directionalIndices: PackedWords;
@group(0) @binding(3) var<storage, read_write> headers: PackedWords;
@group(0) @binding(4) var<storage, read_write> lightIndices: PackedWords;
@group(0) @binding(5) var<storage, read_write> overflow: PackedWords;

fn squaredDistanceToReceiver(lightBase: u32, receiverBase: u32) -> f32 {
  let lightPos = vec3<f32>(
    bitcast<f32>(lights.values[lightBase + 4u]),
    bitcast<f32>(lights.values[lightBase + 5u]),
    bitcast<f32>(lights.values[lightBase + 6u])
  );
  let range = bitcast<f32>(lights.values[lightBase + 7u]);
  let boundsKind = receivers.values[receiverBase + 3u];
  if (boundsKind == BOUNDS_KIND_SPHERE) {
    let receiverPos = vec3<f32>(
      bitcast<f32>(receivers.values[receiverBase + 4u]),
      bitcast<f32>(receivers.values[receiverBase + 5u]),
      bitcast<f32>(receivers.values[receiverBase + 6u])
    );
    let receiverRadius = bitcast<f32>(receivers.values[receiverBase + 7u]);
    return distanceSquaredSphereToSphere(lightPos, range, receiverPos, receiverRadius);
  }
  let minBox = vec3<f32>(
    bitcast<f32>(receivers.values[receiverBase + 4u]),
    bitcast<f32>(receivers.values[receiverBase + 5u]),
    bitcast<f32>(receivers.values[receiverBase + 6u])
  );
  let maxBox = vec3<f32>(
    bitcast<f32>(receivers.values[receiverBase + 8u]),
    bitcast<f32>(receivers.values[receiverBase + 9u]),
    bitcast<f32>(receivers.values[receiverBase + 10u])
  );
  return distanceSquaredSphereToAabb(lightPos, range, minBox, maxBox);
}

@compute @workgroup_size(1)
fn buildLightList() {
  let lightCount = lights.values[0];
  let viewLayerMask = lights.values[1];
  let receiverCount = receivers.values[0];
  let maxLightsPerReceiver = receivers.values[1];
  let maxDirectional = receivers.values[2];
  let configuredMaxIndices = receivers.values[3];
  let maxHeaders = arrayLength(&headers.values) / 4u;
  let maxIndices = min(configuredMaxIndices, arrayLength(&lightIndices.values));
  var directionalCount = 0u;
  var flags = 0u;
  for (var lightIndex = 0u; lightIndex < lightCount; lightIndex += 1u) {
    let lightBase = LIGHT_HEADER_WORDS + lightIndex * LIGHT_RECORD_WORDS;
    let lightEnabled = (lights.values[lightBase + 1u] & 1u) != 0u;
    let visible = (lights.values[lightBase + 2u] & viewLayerMask) != 0u;
    if (lightEnabled && visible && lights.values[lightBase] == LIGHT_KIND_DIRECTIONAL) {
      if (directionalCount < maxDirectional) {
        directionalIndices.values[directionalCount] = lightIndex;
        directionalCount += 1u;
      } else {
        flags |= LIGHT_FLAG_DIRECTIONAL_OVERFLOW;
      }
    }
  }

  var headerCount = 0u;
  var emittedCount = 0u;
  for (var receiverIndex = 0u; receiverIndex < receiverCount; receiverIndex += 1u) {
    let receiverBase = LIGHT_HEADER_WORDS + receiverIndex * RECEIVER_RECORD_WORDS;
    let receiverEnabled = receivers.values[receiverBase + 1u] != 0u;
    let visible = (receivers.values[receiverBase + 2u] & viewLayerMask) != 0u;
    if (!receiverEnabled || !visible || headerCount >= maxHeaders) {
      continue;
    }
    let offset = emittedCount;
    var receiverLightCount = 0u;
    var receiverOverflow = 0u;
    for (var lightIndex = 0u; lightIndex < lightCount; lightIndex += 1u) {
      let lightBase = LIGHT_HEADER_WORDS + lightIndex * LIGHT_RECORD_WORDS;
      let lightActive = (lights.values[lightBase + 1u] & 1u) != 0u;
      let lightLayerMask = lights.values[lightBase + 2u];
      let layerMatch =
        (lightLayerMask & viewLayerMask) != 0u &&
        (lightLayerMask & receivers.values[receiverBase + 2u]) != 0u;
      if (!lightActive || !layerMatch || lights.values[lightBase] == LIGHT_KIND_DIRECTIONAL) {
        continue;
      }
      if (squaredDistanceToReceiver(lightBase, receiverBase) <= 0.0) {
        if (receiverLightCount < maxLightsPerReceiver && emittedCount < maxIndices) {
          lightIndices.values[emittedCount] = lightIndex;
          emittedCount += 1u;
          receiverLightCount += 1u;
        } else {
          receiverOverflow = 1u;
          flags |= LIGHT_FLAG_LOCAL_OVERFLOW;
        }
      }
    }
    let headerBase = headerCount * 4u;
    headers.values[headerBase] = receivers.values[receiverBase];
    headers.values[headerBase + 1u] = offset;
    headers.values[headerBase + 2u] = receiverLightCount;
    headers.values[headerBase + 3u] = receiverOverflow;
    headerCount += 1u;
  }
  overflow.values[0] = flags | min(directionalCount, 0x3fffffffu);
  overflow.values[1] = headerCount;
  overflow.values[2] = emittedCount;
}
