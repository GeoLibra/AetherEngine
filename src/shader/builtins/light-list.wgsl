struct PackedWords {
  values: array<u32>,
}

@group(0) @binding(0) var<storage, read> lights: PackedWords;
@group(0) @binding(1) var<storage, read> receivers: PackedWords;
@group(0) @binding(2) var<storage, read_write> directionalIndices: PackedWords;
@group(0) @binding(3) var<storage, read_write> headers: PackedWords;
@group(0) @binding(4) var<storage, read_write> lightIndices: PackedWords;
@group(0) @binding(5) var<storage, read_write> overflow: PackedWords;

const HEADER_WORDS: u32 = 4u;
const LIGHT_WORDS: u32 = 8u;
const RECEIVER_WORDS: u32 = 12u;
const DIRECTIONAL_KIND: u32 = 0u;
const SPHERE_BOUNDS: u32 = 0u;
const DIRECTIONAL_OVERFLOW: u32 = 0x80000000u;
const LOCAL_OVERFLOW: u32 = 0x40000000u;

fn squaredDistanceToReceiver(lightBase: u32, receiverBase: u32) -> f32 {
  let px = bitcast<f32>(lights.values[lightBase + 4u]);
  let py = bitcast<f32>(lights.values[lightBase + 5u]);
  let pz = bitcast<f32>(lights.values[lightBase + 6u]);
  let range = bitcast<f32>(lights.values[lightBase + 7u]);
  let boundsKind = receivers.values[receiverBase + 3u];
  if (boundsKind == SPHERE_BOUNDS) {
    let dx = px - bitcast<f32>(receivers.values[receiverBase + 4u]);
    let dy = py - bitcast<f32>(receivers.values[receiverBase + 5u]);
    let dz = pz - bitcast<f32>(receivers.values[receiverBase + 6u]);
    let combined = range + bitcast<f32>(receivers.values[receiverBase + 7u]);
    return dx * dx + dy * dy + dz * dz - combined * combined;
  }
  let minX = bitcast<f32>(receivers.values[receiverBase + 4u]);
  let minY = bitcast<f32>(receivers.values[receiverBase + 5u]);
  let minZ = bitcast<f32>(receivers.values[receiverBase + 6u]);
  let maxX = bitcast<f32>(receivers.values[receiverBase + 8u]);
  let maxY = bitcast<f32>(receivers.values[receiverBase + 9u]);
  let maxZ = bitcast<f32>(receivers.values[receiverBase + 10u]);
  let dx = px - clamp(px, minX, maxX);
  let dy = py - clamp(py, minY, maxY);
  let dz = pz - clamp(pz, minZ, maxZ);
  return dx * dx + dy * dy + dz * dz - range * range;
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
    let lightBase = HEADER_WORDS + lightIndex * LIGHT_WORDS;
    let lightEnabled = lights.values[lightBase + 1u] != 0u;
    let visible = (lights.values[lightBase + 2u] & viewLayerMask) != 0u;
    if (lightEnabled && visible && lights.values[lightBase] == DIRECTIONAL_KIND) {
      if (directionalCount < maxDirectional) {
        directionalIndices.values[directionalCount] = lightIndex;
        directionalCount += 1u;
      } else {
        flags |= DIRECTIONAL_OVERFLOW;
      }
    }
  }

  var headerCount = 0u;
  var emittedCount = 0u;
  for (var receiverIndex = 0u; receiverIndex < receiverCount; receiverIndex += 1u) {
    let receiverBase = HEADER_WORDS + receiverIndex * RECEIVER_WORDS;
    let receiverEnabled = receivers.values[receiverBase + 1u] != 0u;
    let visible = (receivers.values[receiverBase + 2u] & viewLayerMask) != 0u;
    if (!receiverEnabled || !visible || headerCount >= maxHeaders) {
      continue;
    }
    let offset = emittedCount;
    var receiverLightCount = 0u;
    var receiverOverflow = 0u;
    for (var lightIndex = 0u; lightIndex < lightCount; lightIndex += 1u) {
      let lightBase = HEADER_WORDS + lightIndex * LIGHT_WORDS;
      let lightActive = lights.values[lightBase + 1u] != 0u;
      let lightLayerMask = lights.values[lightBase + 2u];
      let layerMatch =
        (lightLayerMask & viewLayerMask) != 0u &&
        (lightLayerMask & receivers.values[receiverBase + 2u]) != 0u;
      if (!lightActive || !layerMatch || lights.values[lightBase] == DIRECTIONAL_KIND) {
        continue;
      }
      if (squaredDistanceToReceiver(lightBase, receiverBase) <= 0.0) {
        if (receiverLightCount < maxLightsPerReceiver && emittedCount < maxIndices) {
          lightIndices.values[emittedCount] = lightIndex;
          emittedCount += 1u;
          receiverLightCount += 1u;
        } else {
          receiverOverflow = 1u;
          flags |= LOCAL_OVERFLOW;
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
