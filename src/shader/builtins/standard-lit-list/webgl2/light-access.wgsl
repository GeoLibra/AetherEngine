// ============================================================================
// AetherEngine Standard PBR Shader - WebGL2 Light Access
// Integer 2D texture bindings and texture-load light list accessors.
// ============================================================================

@group(3) @binding(0) var lightWords: texture_2d<u32>;
@group(3) @binding(1) var directionalWords: texture_2d<u32>;
@group(3) @binding(2) var headerWords: texture_2d<u32>;
@group(3) @binding(3) var indexWords: texture_2d<u32>;
@group(3) @binding(4) var overflowWords: texture_2d<u32>;

fn textureWord(source: texture_2d<u32>, word: u32) -> u32 {
  let dimensions = textureDimensions(source);
  let texel = word / 4u;
  return textureLoad(
    source, vec2i(i32(texel % dimensions.x), i32(texel / dimensions.x)), 0
  )[word % 4u];
}

fn lightWord(word: u32) -> u32 {
  return textureWord(lightWords, word);
}

fn directionalLightCount() -> u32 {
  return textureWord(overflowWords, 0u) & 0x3fffffffu;
}

fn directionalIndex(index: u32) -> u32 {
  return textureWord(directionalWords, index);
}

fn receiverLightHeader() -> ReceiverLightHeader {
  let dimensions = textureDimensions(headerWords);
  for (var texel = 0u; texel < dimensions.x * dimensions.y; texel += 1u) {
    let base = texel * 4u;
    let flags = textureWord(headerWords, base + 3u);
    if ((flags & 0x80000000u) != 0u && textureWord(headerWords, base) == objectData.receiver) {
      return ReceiverLightHeader(texel, textureWord(headerWords, base + 2u));
    }
  }
  return ReceiverLightHeader(0u, 0u);
}

fn receiverLightIndex(header: ReceiverLightHeader, index: u32) -> u32 {
  let listWidth = textureDimensions(indexWords).x;
  let fixedWord =
    (header.offset + (1u + index / 4u) * listWidth) * 4u + index % 4u;
  return textureWord(indexWords, fixedWord);
}
