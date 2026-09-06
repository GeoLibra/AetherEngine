import type { CpuLightListCapacity, LightReceiver, PreparedLight } from '../types';
import type { DecodedWebGpuLightListOutput } from './light-list-abi';
import { packWebGpuLightListInput } from './light-list-abi';
import { calculateWebGlLightListPacking } from './light-list-packing';

const WORDS_PER_TEXEL = 4;
const VALID_HEADER = 0x8000_0000;

export interface PackedWebGlLightListInput {
  readonly orderedLights: readonly PreparedLight[];
  readonly width: number;
  readonly lightsHeight: number;
  readonly receiversHeight: number;
  readonly lights: Uint32Array;
  readonly receivers: Uint32Array;
}

/** Packs the shared word ABI into RGBA32Uint texels owned by the caller. */
export function packWebGlLightListInput(input: {
  readonly viewLayerMask: number;
  readonly lights: readonly PreparedLight[];
  readonly receivers: readonly LightReceiver[];
  readonly capacity: CpuLightListCapacity;
  readonly maxTextureDimension2D: number;
}): PackedWebGlLightListInput {
  const packed = packWebGpuLightListInput(input);
  const packing = calculateWebGlLightListPacking(
    input.receivers.length,
    input.capacity,
    input.maxTextureDimension2D
  );
  const pack = (words: Uint32Array) => {
    const height = Math.max(1, Math.ceil(words.length / (packing.width * WORDS_PER_TEXEL)));
    if (height > input.maxTextureDimension2D)
      throw new Error('Packed WebGL2 light-list input exceeds maxTextureDimension2D.');
    const texels = new Uint32Array(packing.width * height * WORDS_PER_TEXEL);
    texels.set(words);
    return { height, texels };
  };
  const lights = pack(packed.lights);
  const receivers = pack(packed.receivers);
  return {
    orderedLights: packed.orderedLights,
    width: packing.width,
    lightsHeight: lights.height,
    receiversHeight: receivers.height,
    lights: lights.texels,
    receivers: receivers.texels
  };
}

/** Decodes integer MRT texels into the backend-neutral compact light-list contract. */
export function decodeWebGlLightListOutput(input: {
  readonly receiverCount: number;
  readonly capacity: CpuLightListCapacity;
  readonly width: number;
  readonly directional: Uint32Array;
  readonly headers: Uint32Array;
  readonly indices: Uint32Array;
  readonly overflow: Uint32Array;
}): DecodedWebGpuLightListOutput {
  const directionalWord = requiredWord(input.overflow, 0, 'overflow');
  const directionalCount = directionalWord & 0x3fff_ffff;
  if (directionalCount > input.capacity.maxDirectionalLights)
    throw new Error('WebGL2 directional count exceeds configured capacity.');
  const directionalIndices = Array.from({ length: directionalCount }, (_, index) =>
    requiredWord(input.directional, index, 'directional')
  );
  const indexRows = Math.ceil(input.capacity.maxLightsPerReceiver / WORDS_PER_TEXEL);
  const blockHeight = 1 + indexRows;
  const headers: Array<{
    receiver: number;
    offset: number;
    count: number;
    overflowed: boolean;
  }> = [];
  const lightIndices: number[] = [];
  let overflowed = (directionalWord & 0xc000_0000) !== 0;
  for (let receiverIndex = 0; receiverIndex < input.receiverCount; receiverIndex += 1) {
    const x = receiverIndex % input.width;
    const blockY = Math.floor(receiverIndex / input.width) * blockHeight;
    const headerBase = (blockY * input.width + x) * WORDS_PER_TEXEL;
    const flags = requiredWord(input.headers, headerBase + 3, 'header');
    if ((flags & VALID_HEADER) === 0) continue;
    const count = requiredWord(input.headers, headerBase + 2, 'header');
    const offset = requiredWord(input.headers, headerBase + 1, 'header');
    if (count > input.capacity.maxLightsPerReceiver || offset !== lightIndices.length)
      throw new Error('WebGL2 light-list header violates compact output invariants.');
    headers.push({
      receiver: requiredWord(input.headers, headerBase, 'header'),
      offset,
      count,
      overflowed: (flags & 1) !== 0
    });
    overflowed ||= (flags & 1) !== 0;
    for (let index = 0; index < count; index += 1) {
      const row = blockY + 1 + Math.floor(index / WORDS_PER_TEXEL);
      const word = (row * input.width + x) * WORDS_PER_TEXEL + (index % WORDS_PER_TEXEL);
      lightIndices.push(requiredWord(input.indices, word, 'index'));
    }
  }
  return Object.freeze({
    directionalIndices: Object.freeze(directionalIndices),
    headers: Object.freeze(headers.map((header) => Object.freeze(header))),
    lightIndices: Object.freeze(lightIndices),
    overflowed
  });
}

function requiredWord(words: Uint32Array, index: number, label: string): number {
  const value = words[index];
  if (value === undefined) throw new Error(`WebGL2 light-list ${label} readback is truncated.`);
  return value;
}
