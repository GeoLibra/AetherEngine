import type { RHIBuffer, RHIDevice, RHITexture } from '../../../rhi/contracts';
import type {
  CpuLightListCapacity,
  CpuLightListHeader,
  CpuLightListResult,
  LightReceiver,
  PreparedLight
} from '../../lighting/types';
import {
  LIGHT_LIST_SHADER_MAX_DIRECTIONAL_LIGHTS,
  LIGHT_LIST_SHADER_MAX_INDICES,
  LIGHT_LIST_LIGHT_WORDS,
  LIGHT_LIST_SHADER_MAX_LIGHTS,
  LIGHT_LIST_SHADER_MAX_RECEIVERS,
  packWebGpuLightListInput
} from '../../lighting/culling/light-list-abi';
import { packWebGlLightListInput } from '../../lighting/culling/light-list-webgl-abi';
import { calculateWebGlLightListPacking } from '../../lighting/culling/light-list-packing';

const STORAGE_UNIFORM_UPLOAD_BUFFER_USAGE = (1 << 3) | (1 << 6) | (1 << 7);
const SAMPLED_UPLOAD_TEXTURE_USAGE = (1 << 2) | (1 << 4);

export interface PackedWebGpuCpuLightListWords {
  readonly lightWords: Uint32Array;
  readonly directionalWords: Uint32Array;
  readonly headerWords: Uint32Array;
  readonly indexWords: Uint32Array;
  readonly overflowWords: Uint32Array;
}

export interface PackedWebGlCpuLightListTexels {
  readonly width: number;
  readonly height: number;
  readonly lightsHeight: number;
  readonly lightsTexels: Uint32Array;
  readonly directionalTexels: Uint32Array;
  readonly headerTexels: Uint32Array;
  readonly indexTexels: Uint32Array;
  readonly overflowTexels: Uint32Array;
}

/**
 * Pure packing of CPU light list execution results into WebGPU uniform buffer word layouts.
 */
export function packCpuLightListForWebGpu(
  input: {
    readonly viewLayerMask: number;
    readonly lights: readonly PreparedLight[];
    readonly receivers: readonly LightReceiver[];
  },
  capacity: CpuLightListCapacity,
  cpuResult: CpuLightListResult
): PackedWebGpuCpuLightListWords {
  const packedGpu = packWebGpuLightListInput({ ...input, capacity });
  const lightWords = new Uint32Array(4 + LIGHT_LIST_SHADER_MAX_LIGHTS * LIGHT_LIST_LIGHT_WORDS);
  lightWords.set(packedGpu.lights);

  const directionalWords = new Uint32Array(LIGHT_LIST_SHADER_MAX_DIRECTIONAL_LIGHTS);
  const directionalSlice =
    cpuResult.globalDirectionalLightIndices.length > LIGHT_LIST_SHADER_MAX_DIRECTIONAL_LIGHTS
      ? cpuResult.globalDirectionalLightIndices.slice(0, LIGHT_LIST_SHADER_MAX_DIRECTIONAL_LIGHTS)
      : cpuResult.globalDirectionalLightIndices;
  directionalWords.set(directionalSlice);

  const headerWords = new Uint32Array(LIGHT_LIST_SHADER_MAX_RECEIVERS * 4);
  const headerCount = Math.min(cpuResult.headers.length, LIGHT_LIST_SHADER_MAX_RECEIVERS);
  for (let index = 0; index < headerCount; index++) {
    const h = cpuResult.headers[index]!;
    const base = index * 4;
    headerWords[base] = h.receiver;
    headerWords[base + 1] = h.offset;
    headerWords[base + 2] = h.count;
    headerWords[base + 3] = h.overflowed ? 1 : 0;
  }

  const indexWords = new Uint32Array(LIGHT_LIST_SHADER_MAX_INDICES);
  const indexSlice =
    cpuResult.lightIndices.length > LIGHT_LIST_SHADER_MAX_INDICES
      ? cpuResult.lightIndices.slice(0, LIGHT_LIST_SHADER_MAX_INDICES)
      : cpuResult.lightIndices;
  indexWords.set(indexSlice);

  const overflowWords = new Uint32Array(4);
  const directionalCount = directionalSlice.length;
  const flags = (cpuResult.overflowed ? 0xc000_0000 : 0) | (directionalCount & 0x3fff_ffff);
  overflowWords[0] = flags;
  overflowWords[1] = headerCount;
  overflowWords[2] = indexSlice.length;
  overflowWords[3] = 0;

  return {
    lightWords,
    directionalWords,
    headerWords,
    indexWords,
    overflowWords
  };
}

/**
 * Pure packing of CPU light list execution results into WebGL2 RGBA32Uint texel layouts.
 * Conforms to decodeWebGlLightListOutput invariants:
 * - VALID_HEADER (0x8000_0000) set on active header texels
 * - Interleaved rows: header row followed by ceil(maxLightsPerReceiver / 4) index rows
 */
export function packCpuLightListForWebGl(
  input: {
    readonly viewLayerMask: number;
    readonly lights: readonly PreparedLight[];
    readonly receivers: readonly LightReceiver[];
  },
  capacity: CpuLightListCapacity,
  maxTextureDimension2D: number,
  cpuResult: CpuLightListResult
): PackedWebGlCpuLightListTexels {
  const packed = packWebGlLightListInput({
    ...input,
    capacity,
    maxTextureDimension2D
  });

  const packing = calculateWebGlLightListPacking(
    input.receivers.length,
    capacity,
    maxTextureDimension2D
  );

  const directionalTexels = new Uint32Array(packing.width * packing.height * 4);
  directionalTexels.set(cpuResult.globalDirectionalLightIndices);

  const headerTexels = new Uint32Array(packing.width * packing.height * 4);
  const indexTexels = new Uint32Array(packing.width * packing.height * 4);
  const blockHeight = 1 + packing.indexRows;

  cpuResult.headers.forEach((h: CpuLightListHeader, receiverIndex: number) => {
    const x = receiverIndex % packing.width;
    const blockY = Math.floor(receiverIndex / packing.width) * blockHeight;
    const headerBase = (blockY * packing.width + x) * 4;
    headerTexels[headerBase] = h.receiver;
    headerTexels[headerBase + 1] = h.offset;
    headerTexels[headerBase + 2] = h.count;
    headerTexels[headerBase + 3] = 0x8000_0000 | (h.overflowed ? 1 : 0);

    const receiverIndices = cpuResult.lightIndices.slice(h.offset, h.offset + h.count);
    receiverIndices.forEach((lightIdx: number, idx: number) => {
      const row = blockY + 1 + Math.floor(idx / 4);
      const word = (row * packing.width + x) * 4 + (idx % 4);
      indexTexels[word] = lightIdx;
    });
  });

  const overflowTexels = new Uint32Array(packing.width * packing.height * 4);
  const dirCount = cpuResult.globalDirectionalLightIndices.length;
  overflowTexels[0] = (cpuResult.overflowed ? 0xc000_0000 : 0) | (dirCount & 0x3fff_ffff);

  return {
    width: packing.width,
    height: packing.height,
    lightsHeight: packed.lightsHeight,
    lightsTexels: packed.lights,
    directionalTexels,
    headerTexels,
    indexTexels,
    overflowTexels
  };
}

export interface UploadedWebGpuCpuLightListBuffers {
  readonly lights: RHIBuffer;
  readonly directional: RHIBuffer;
  readonly headers: RHIBuffer;
  readonly indices: RHIBuffer;
  readonly overflow: RHIBuffer;
}

export interface UploadedWebGlCpuLightListTextures {
  readonly lights: RHITexture;
  readonly directional: RHITexture;
  readonly headers: RHITexture;
  readonly indices: RHITexture;
  readonly overflow: RHITexture;
}

/**
 * Uploads packed WebGPU CPU light list words to RHI uniform buffers.
 */
export function uploadCpuLightListWebGpu(
  device: RHIDevice,
  packedWords: PackedWebGpuCpuLightListWords
): UploadedWebGpuCpuLightListBuffers {
  const createUniformBuffer = (words: Uint32Array): RHIBuffer => {
    const buffer = device.createBuffer({
      size: words.byteLength,
      usage: STORAGE_UNIFORM_UPLOAD_BUFFER_USAGE
    });
    device.queue.writeBuffer(buffer, 0, words);
    return buffer;
  };

  const lights = device.createBuffer({
    size: packedWords.lightWords.byteLength,
    usage: STORAGE_UNIFORM_UPLOAD_BUFFER_USAGE
  });
  device.queue.writeBuffer(lights, 0, packedWords.lightWords);

  return {
    lights,
    directional: createUniformBuffer(packedWords.directionalWords),
    headers: createUniformBuffer(packedWords.headerWords),
    indices: createUniformBuffer(packedWords.indexWords),
    overflow: createUniformBuffer(packedWords.overflowWords)
  };
}

/**
 * Uploads packed WebGL2 CPU light list texels to RGBA32Uint textures.
 */
export function uploadCpuLightListWebGl(
  device: RHIDevice,
  packedTexels: PackedWebGlCpuLightListTexels
): UploadedWebGlCpuLightListTextures {
  const createTexture = (height: number, words: Uint32Array): RHITexture => {
    const texture = device.createTexture({
      size: [packedTexels.width, height],
      format: 'rgba32uint',
      usage: SAMPLED_UPLOAD_TEXTURE_USAGE
    });
    device.queue.writeTexture(
      { texture },
      words,
      { bytesPerRow: packedTexels.width * 16, rowsPerImage: height },
      { width: packedTexels.width, height }
    );
    return texture;
  };

  return {
    lights: createTexture(packedTexels.lightsHeight, packedTexels.lightsTexels),
    directional: createTexture(packedTexels.height, packedTexels.directionalTexels),
    headers: createTexture(packedTexels.height, packedTexels.headerTexels),
    indices: createTexture(packedTexels.height, packedTexels.indexTexels),
    overflow: createTexture(packedTexels.height, packedTexels.overflowTexels)
  };
}
