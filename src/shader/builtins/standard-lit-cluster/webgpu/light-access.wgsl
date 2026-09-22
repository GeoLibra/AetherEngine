// ============================================================================
// AetherEngine Standard PBR Shader - WebGPU Clustered Forward Light Access
// The cluster compute output uses the standard 16-word packed-light record ABI.
// ============================================================================

struct PackedLightWords { values: array<vec4<u32>, 1025> };
struct PackedDirectionalWords { values: array<vec4<u32>, 16> };
struct PackedClusterHeaderWords { values: array<vec4<u32>, 256> };
struct PackedIndexWords { values: array<vec4<u32>, 1024> };
struct PackedOverflowWords { values: vec4<u32> };
struct ClusterForwardMetadata { values: array<vec4<u32>, 34> };

@group(3) @binding(0) var<uniform> lightWords: PackedLightWords;
@group(3) @binding(1) var<uniform> directionalWords: PackedDirectionalWords;
@group(3) @binding(2) var<uniform> clusterHeaderWords: PackedClusterHeaderWords;
@group(3) @binding(3) var<uniform> indexWords: PackedIndexWords;
@group(3) @binding(4) var<uniform> overflowWords: PackedOverflowWords;
@group(3) @binding(14) var<uniform> clusterMetadata: ClusterForwardMetadata;

fn lightWord(word: u32) -> u32 {
  return lightWords.values[word / 4u][word % 4u];
}

fn directionalLightCount() -> u32 {
  return overflowWords.values.x & 0x3fffffffu;
}

fn directionalIndex(index: u32) -> u32 {
  return directionalWords.values[index / 4u][index % 4u];
}

fn clusterMetadataWord(word: u32) -> u32 {
  return clusterMetadata.values[word / 4u][word % 4u];
}

fn selectClusterHeader(fragmentPosition: vec4<f32>, worldPosition: vec3<f32>) -> ReceiverLightHeader {
  let tilesX = clusterMetadataWord(0u);
  let tilesY = clusterMetadataWord(1u);
  let width = clusterMetadataWord(2u);
  let height = clusterMetadataWord(3u);
  let sliceCount = clusterMetadataWord(5u);
  let clusterCount = clusterMetadataWord(6u);
  if (tilesX == 0u || tilesY == 0u || width == 0u || height == 0u || sliceCount == 0u) {
    return ReceiverLightHeader(0u, 0u);
  }
  if (fragmentPosition.x < 0.0 || fragmentPosition.y < 0.0 || fragmentPosition.x >= f32(width) || fragmentPosition.y >= f32(height)) {
    return ReceiverLightHeader(0u, 0u);
  }
  let pixelX = u32(fragmentPosition.x);
  let pixelY = u32(fragmentPosition.y);
  let tileX = min(tilesX - 1u, pixelX * tilesX / width);
  let tileY = min(tilesY - 1u, pixelY * tilesY / height);
  let cameraDepth = -(viewData.view * vec4<f32>(worldPosition, 1.0)).z;
  var slice = sliceCount;
  for (var index = 0u; index < sliceCount; index += 1u) {
    let near = bitcast<f32>(clusterMetadataWord(8u + index * 2u));
    let far = bitcast<f32>(clusterMetadataWord(9u + index * 2u));
    let finalSlice = index + 1u == sliceCount;
    if (cameraDepth >= near && (cameraDepth < far || (finalSlice && cameraDepth <= far))) {
      slice = index;
      break;
    }
  }
  if (slice == sliceCount) { return ReceiverLightHeader(0u, 0u); }
  let cluster = (slice * tilesY + tileY) * tilesX + tileX;
  if (cluster >= clusterCount || cluster >= 256u) { return ReceiverLightHeader(0u, 0u); }
  let header = clusterHeaderWords.values[cluster];
  if (header.x != cluster) { return ReceiverLightHeader(0u, 0u); }
  return ReceiverLightHeader(header.y, header.z);
}
