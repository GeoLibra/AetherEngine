@group(0) @binding(0) var lightWords: texture_2d<u32>;
@group(0) @binding(1) var receiverWords: texture_2d<u32>;

struct VertexOutput {
  @builtin(position) position: vec4f,
}

struct FragmentOutput {
  @location(0) directional: vec4u,
  @location(1) header: vec4u,
  @location(2) indices: vec4u,
  @location(3) overflow: vec4u,
}

fn loadWord(source: texture_2d<u32>, word: u32) -> u32 {
  let dimensions = textureDimensions(source);
  let texel = word / 4u;
  let coordinate = vec2i(i32(texel % dimensions.x), i32(texel / dimensions.x));
  return textureLoad(source, coordinate, 0)[word % 4u];
}

fn squaredDistanceToReceiver(lightBase: u32, receiverBase: u32) -> f32 {
  let lightPos = vec3<f32>(
    bitcast<f32>(loadWord(lightWords, lightBase + 4u)),
    bitcast<f32>(loadWord(lightWords, lightBase + 5u)),
    bitcast<f32>(loadWord(lightWords, lightBase + 6u))
  );
  let range = bitcast<f32>(loadWord(lightWords, lightBase + 7u));
  if (loadWord(receiverWords, receiverBase + 3u) == BOUNDS_KIND_SPHERE) {
    let receiverPos = vec3<f32>(
      bitcast<f32>(loadWord(receiverWords, receiverBase + 4u)),
      bitcast<f32>(loadWord(receiverWords, receiverBase + 5u)),
      bitcast<f32>(loadWord(receiverWords, receiverBase + 6u))
    );
    let receiverRadius = bitcast<f32>(loadWord(receiverWords, receiverBase + 7u));
    return distanceSquaredSphereToSphere(lightPos, range, receiverPos, receiverRadius);
  }
  let minBox = vec3<f32>(
    bitcast<f32>(loadWord(receiverWords, receiverBase + 4u)),
    bitcast<f32>(loadWord(receiverWords, receiverBase + 5u)),
    bitcast<f32>(loadWord(receiverWords, receiverBase + 6u))
  );
  let maxBox = vec3<f32>(
    bitcast<f32>(loadWord(receiverWords, receiverBase + 8u)),
    bitcast<f32>(loadWord(receiverWords, receiverBase + 9u)),
    bitcast<f32>(loadWord(receiverWords, receiverBase + 10u))
  );
  return distanceSquaredSphereToAabb(lightPos, range, minBox, maxBox);
}

fn localLightAt(receiverBase: u32, requested: u32) -> vec2u {
  let lightCount = loadWord(lightWords, 0u);
  let viewLayerMask = loadWord(lightWords, 1u);
  var accepted = 0u;
  var candidates = 0u;
  var result = 0u;
  for (var lightIndex = 0u; lightIndex < lightCount; lightIndex += 1u) {
    let lightBase = LIGHT_HEADER_WORDS + lightIndex * LIGHT_RECORD_WORDS;
    let lightLayerMask = loadWord(lightWords, lightBase + 2u);
    let eligible =
      loadWord(lightWords, lightBase) != 0u &&
      (loadWord(lightWords, lightBase + 1u) & 1u) != 0u &&
      (lightLayerMask & viewLayerMask) != 0u &&
      (lightLayerMask & loadWord(receiverWords, receiverBase + 2u)) != 0u;
    if (eligible && squaredDistanceToReceiver(lightBase, receiverBase) <= 0.0) {
      if (accepted == requested) {
        result = lightIndex;
      }
      accepted += 1u;
      candidates += 1u;
    }
  }
  return vec2u(result, candidates);
}

fn localCandidateCount(receiverIndex: u32) -> u32 {
  let receiverBase = LIGHT_HEADER_WORDS + receiverIndex * RECEIVER_RECORD_WORDS;
  let enabled = loadWord(receiverWords, receiverBase + 1u) != 0u;
  let visible =
    (loadWord(receiverWords, receiverBase + 2u) & loadWord(lightWords, 1u)) != 0u;
  if (!enabled || !visible) {
    return 0u;
  }
  return localLightAt(receiverBase, 0u).y;
}

fn compactOffset(receiverIndex: u32, maxLightsPerReceiver: u32, maxLightIndices: u32) -> u32 {
  var offset = 0u;
  for (var prior = 0u; prior < receiverIndex; prior += 1u) {
    offset = min(maxLightIndices, offset + min(localCandidateCount(prior), maxLightsPerReceiver));
  }
  return offset;
}

@vertex
fn lightListVertex(@builtin(vertex_index) index: u32) -> VertexOutput {
  var output: VertexOutput;
  output.position = fullscreenClipPosition(index);
  return output;
}

@fragment
fn lightListFragment(input: VertexOutput) -> FragmentOutput {
  let coordinate = vec2u(input.position.xy);
  let width = textureDimensions(receiverWords).x;
  let receiverCount = loadWord(receiverWords, 0u);
  let maxLightsPerReceiver = loadWord(receiverWords, 1u);
  let maxDirectional = loadWord(receiverWords, 2u);
  let maxLightIndices = loadWord(receiverWords, 3u);
  let indexRows = (maxLightsPerReceiver + 3u) / 4u;
  let blockHeight = 1u + indexRows;
  let receiverIndex = (coordinate.y / blockHeight) * width + coordinate.x;
  let rowInBlock = coordinate.y % blockHeight;
  var output: FragmentOutput;

  if (coordinate.y == 0u) {
    let lightCount = loadWord(lightWords, 0u);
    let viewLayerMask = loadWord(lightWords, 1u);
    var directionalCount = 0u;
    for (var lightIndex = 0u; lightIndex < lightCount; lightIndex += 1u) {
      let lightBase = LIGHT_HEADER_WORDS + lightIndex * LIGHT_RECORD_WORDS;
      let eligible =
        loadWord(lightWords, lightBase) == LIGHT_KIND_DIRECTIONAL &&
        (loadWord(lightWords, lightBase + 1u) & 1u) != 0u &&
        (loadWord(lightWords, lightBase + 2u) & viewLayerMask) != 0u;
      if (eligible) {
        if (directionalCount < maxDirectional) {
          let outputIndex = coordinate.x * 4u;
          if (directionalCount >= outputIndex && directionalCount < outputIndex + 4u) {
            output.directional[directionalCount - outputIndex] = lightIndex;
          }
        }
        directionalCount += 1u;
      }
    }
    if (coordinate.x == 0u) {
      output.overflow.x = min(directionalCount, maxDirectional) |
        select(0u, LIGHT_FLAG_DIRECTIONAL_OVERFLOW, directionalCount > maxDirectional);
    }
  }

  if (receiverIndex < receiverCount) {
    let receiverBase = LIGHT_HEADER_WORDS + receiverIndex * RECEIVER_RECORD_WORDS;
    let enabled = loadWord(receiverWords, receiverBase + 1u) != 0u;
    let visible =
      (loadWord(receiverWords, receiverBase + 2u) & loadWord(lightWords, 1u)) != 0u;
    if (enabled && visible) {
      let first = select(0u, (rowInBlock - 1u) * 4u, rowInBlock > 0u);
      let firstResult = localLightAt(receiverBase, first);
      let offset = compactOffset(receiverIndex, maxLightsPerReceiver, maxLightIndices);
      let available = maxLightIndices - offset;
      let emittedCount = min(min(firstResult.y, maxLightsPerReceiver), available);
      if (rowInBlock == 0u) {
        output.header = vec4u(
          loadWord(receiverWords, receiverBase),
          offset,
          emittedCount,
          LIGHT_FLAG_VALID_HEADER | select(0u, 1u, firstResult.y > emittedCount)
        );
      } else {
        for (var lane = 0u; lane < 4u; lane += 1u) {
          let requested = first + lane;
          if (requested < emittedCount) {
            output.indices[lane] = localLightAt(receiverBase, requested).x;
          }
        }
      }
    }
  }
  return output;
}
