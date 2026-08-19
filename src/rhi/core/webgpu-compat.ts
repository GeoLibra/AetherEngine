import type { GPUExtent3D } from '../contracts';
import type {
  RHIBufferDescriptor,
  RHISamplerDescriptor,
  RHITextureDescriptor
} from '../contracts/descriptor';

const BUFFER_FIELDS = new Set(['label', 'size', 'usage', 'mappedAtCreation']);
const TEXTURE_FIELDS = new Set([
  'label',
  'size',
  'format',
  'usage',
  'dimension',
  'mipLevelCount',
  'sampleCount'
]);
const SAMPLER_FIELDS = new Set([
  'label',
  'addressModeU',
  'addressModeV',
  'addressModeW',
  'magFilter',
  'minFilter',
  'mipmapFilter',
  'lodMinClamp',
  'lodMaxClamp',
  'compare',
  'maxAnisotropy'
]);

export const webgpuCompat = Object.freeze({
  bufferDescriptor(input: RHIBufferDescriptor): Readonly<RHIBufferDescriptor> {
    assertKnownFields('buffer', input, BUFFER_FIELDS);
    const descriptor: RHIBufferDescriptor = {
      size: input.size,
      usage: input.usage,
      mappedAtCreation: input.mappedAtCreation ?? false
    };
    if (input.label !== undefined) descriptor.label = input.label;
    return Object.freeze(descriptor);
  },

  textureDescriptor(input: RHITextureDescriptor): Readonly<RHITextureDescriptor> {
    assertKnownFields('texture', input, TEXTURE_FIELDS);
    const descriptor: RHITextureDescriptor = {
      size: normalizeExtent(input.size),
      format: input.format,
      usage: input.usage,
      dimension: input.dimension ?? '2d',
      mipLevelCount: input.mipLevelCount ?? 1,
      sampleCount: input.sampleCount ?? 1
    };
    if (input.label !== undefined) descriptor.label = input.label;
    return Object.freeze(descriptor);
  },

  samplerDescriptor(input: RHISamplerDescriptor = {}): Readonly<RHISamplerDescriptor> {
    assertKnownFields('sampler', input, SAMPLER_FIELDS);
    const descriptor: RHISamplerDescriptor = {
      addressModeU: input.addressModeU ?? 'clamp-to-edge',
      addressModeV: input.addressModeV ?? 'clamp-to-edge',
      addressModeW: input.addressModeW ?? 'clamp-to-edge',
      magFilter: input.magFilter ?? 'nearest',
      minFilter: input.minFilter ?? 'nearest',
      mipmapFilter: input.mipmapFilter ?? 'nearest',
      lodMinClamp: input.lodMinClamp ?? 0,
      lodMaxClamp: input.lodMaxClamp ?? 32,
      maxAnisotropy: input.maxAnisotropy ?? 1
    };
    if (input.label !== undefined) descriptor.label = input.label;
    if (input.compare !== undefined) descriptor.compare = input.compare;
    return Object.freeze(descriptor);
  },

  bindGroupDescriptor(input: unknown): never {
    return rejectResourceDescriptor('bind-group', input);
  },

  pipelineLayoutDescriptor(input: unknown): never {
    return rejectResourceDescriptor('pipeline-layout', input);
  },

  renderPipelineDescriptor(input: unknown): never {
    return rejectResourceDescriptor('render-pipeline', input);
  },

  computePipelineDescriptor(input: unknown): never {
    return rejectResourceDescriptor('compute-pipeline', input);
  },

  renderPassDescriptor(input: unknown): never {
    return rejectResourceDescriptor('render-pass', input);
  }
});

function assertKnownFields(kind: string, input: object, allowed: ReadonlySet<string>): void {
  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) {
      throw new Error(`WebGPU ${kind} descriptor field "${field}" is not portable.`);
    }
  }
}

function normalizeExtent(size: GPUExtent3D): RHITextureDescriptor['size'] {
  if (typeof size === 'number') {
    return Object.freeze({ width: size, height: 1, depthOrArrayLayers: 1 });
  }
  if (!('width' in size)) {
    const tuple = size as readonly [number, number?, number?];
    return Object.freeze({
      width: tuple[0] ?? 1,
      height: tuple[1] ?? 1,
      depthOrArrayLayers: tuple[2] ?? 1
    });
  }
  return Object.freeze({
    width: size.width,
    height: size.height ?? 1,
    depthOrArrayLayers: size.depthOrArrayLayers ?? 1
  });
}

function rejectResourceDescriptor(kind: string, _input: unknown): never {
  throw new Error(
    `WebGPU ${kind} descriptors contain resource identities and cannot be converted automatically. ` +
      'Rebind the descriptor with RHI handles.'
  );
}
