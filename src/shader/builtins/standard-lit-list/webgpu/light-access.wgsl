// ============================================================================
// AetherEngine Standard PBR Shader - WebGPU Light Access
// Uniform buffer bindings and light list accessors.
// ============================================================================

// 4 header words + 256 fixed 16-word records, rounded to vec4<u32> elements.
struct PackedLightWords { values: array<vec4<u32>, 1025> };
struct PackedDirectionalWords { values: array<vec4<u32>, 16> };
struct PackedHeaderWords { values: array<vec4<u32>, 256> };
struct PackedIndexWords { values: array<vec4<u32>, 1024> };
struct PackedOverflowWords { values: vec4<u32> };

@group(3) @binding(0) var<uniform> lightWords: PackedLightWords;
@group(3) @binding(1) var<uniform> directionalWords: PackedDirectionalWords;
@group(3) @binding(2) var<uniform> headerWords: PackedHeaderWords;
@group(3) @binding(3) var<uniform> indexWords: PackedIndexWords;
@group(3) @binding(4) var<uniform> overflowWords: PackedOverflowWords;

fn lightWord(word: u32) -> u32 {
  return lightWords.values[word / 4u][word % 4u];
}

fn directionalLightCount() -> u32 {
  return overflowWords.values.x & 0x3fffffffu;
}

fn directionalIndex(index: u32) -> u32 {
  return directionalWords.values[index / 4u][index % 4u];
}

fn receiverLightHeader() -> ReceiverLightHeader {
  for (var index = 0u; index < overflowWords.values.y; index += 1u) {
    let header = headerWords.values[index];
    if (header.x == objectData.receiver) {
      return ReceiverLightHeader(header.y, header.z);
    }
  }
  return ReceiverLightHeader(0u, 0u);
}

fn receiverLightIndex(header: ReceiverLightHeader, index: u32) -> u32 {
  let wordIndex = header.offset + index;
  return indexWords.values[wordIndex / 4u][wordIndex % 4u];
}
