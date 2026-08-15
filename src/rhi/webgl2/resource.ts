import type { RHIResourceState } from '../contracts/lifecycle';
import type {
  RHIBuffer,
  RHIResource,
  RHIResourceKind,
  RHISampler,
  RHITexture,
  RHITextureView
} from '../contracts/resource';
import type {
  RHIBufferDescriptor,
  RHISamplerDescriptor,
  RHITextureDescriptor,
  RHITextureViewDescriptor
} from '../contracts/descriptor';
import type { GPUMapModeFlags, GPUExtent3D } from '../contracts/webgpu';
import { textureMipDimension, validateTextureViewMipLevel } from '../core/texture-dimensions';
import type { WebGL2DeviceOwner } from './types';
import type { WebGL2NativeContextPort, WebGL2NativeObject } from './types';

interface NativeEntry {
  readonly handle: WebGL2NativeObject;
  readonly owned: boolean;
}

const nativeEntries = new WeakMap<WebGL2ResourceBase, NativeEntry>();

export abstract class WebGL2ResourceBase implements RHIResource {
  protected disposed = false;
  abstract readonly kind: RHIResourceKind;

  constructor(
    readonly id: number,
    readonly owner: WebGL2DeviceOwner,
    handle: WebGL2NativeObject,
    readonly label: string | undefined,
    owned = true
  ) {
    nativeEntries.set(this, { handle, owned });
  }

  get generation(): number {
    return this.owner.generation;
  }
  get state(): RHIResourceState {
    if (this.owner.state !== 'live') return 'device-lost';
    return this.disposed ? 'disposed' : 'live';
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const entry = nativeEntries.get(this);
    if (entry === undefined) return;
    nativeEntries.delete(this);
    this.owner.releaseResource(this, entry.handle, entry.owned);
  }
}

export class WebGL2Buffer extends WebGL2ResourceBase implements RHIBuffer {
  readonly kind = 'buffer';
  readonly descriptor: Readonly<RHIBufferDescriptor>;
  readonly size: number;
  readonly usage: number;
  constructor(
    id: number,
    owner: WebGL2DeviceOwner,
    handle: WebGL2NativeObject,
    descriptor: RHIBufferDescriptor
  ) {
    super(id, owner, handle, descriptor.label);
    this.descriptor = freezeWithLabel(
      {
        size: descriptor.size,
        usage: descriptor.usage,
        mappedAtCreation: descriptor.mappedAtCreation ?? false
      },
      descriptor.label
    );
    this.size = descriptor.size;
    this.usage = descriptor.usage;
  }
  mapAsync(_mode: GPUMapModeFlags): Promise<void> {
    return Promise.reject(
      new Error(`WebGL2 buffer "${this.label ?? this.id}" does not support mapAsync.`)
    );
  }
  getMappedRange(): ArrayBuffer {
    throw new Error(`WebGL2 buffer "${this.label ?? this.id}" does not expose a mapped range.`);
  }
  unmap(): void {
    throw new Error(`WebGL2 buffer "${this.label ?? this.id}" is not mapped.`);
  }
}

export class WebGL2Texture extends WebGL2ResourceBase implements RHITexture {
  readonly kind = 'texture';
  readonly descriptor: Readonly<RHITextureDescriptor>;
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly format: string;
  readonly usage: number;
  constructor(
    id: number,
    owner: WebGL2DeviceOwner,
    handle: WebGL2NativeObject,
    descriptor: RHITextureDescriptor,
    owned = true
  ) {
    super(id, owner, handle, descriptor.label, owned);
    const size = normalizeExtent(descriptor.size);
    this.descriptor = freezeWithLabel(
      {
        size,
        format: descriptor.format,
        usage: descriptor.usage,
        dimension: descriptor.dimension ?? '2d',
        mipLevelCount: descriptor.mipLevelCount ?? 1,
        sampleCount: descriptor.sampleCount ?? 1
      },
      descriptor.label
    );
    this.width = size.width;
    this.height = size.height;
    this.depthOrArrayLayers = size.depthOrArrayLayers;
    this.format = descriptor.format;
    this.usage = descriptor.usage;
  }
  createView(descriptor: RHITextureViewDescriptor = {}): RHITextureView {
    const handle = getWebGL2Handle(this, this.owner);
    return new WebGL2TextureView(this.owner.allocateId(), this.owner, handle, this, descriptor);
  }
}

export class WebGL2TextureView extends WebGL2ResourceBase implements RHITextureView {
  readonly kind = 'texture-view';
  readonly descriptor: Readonly<RHITextureViewDescriptor>;
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly format: string;
  constructor(
    id: number,
    owner: WebGL2DeviceOwner,
    handle: WebGL2NativeObject,
    readonly texture: RHITexture,
    descriptor: RHITextureViewDescriptor
  ) {
    super(id, owner, handle, descriptor.label ?? texture.label, false);
    this.descriptor = Object.freeze({ ...descriptor });
    const mipLevel = validateTextureViewMipLevel(
      descriptor.baseMipLevel,
      texture.descriptor.mipLevelCount
    );
    this.width = textureMipDimension(texture.width, mipLevel);
    this.height = textureMipDimension(texture.height, mipLevel);
    this.depthOrArrayLayers = descriptor.arrayLayerCount ?? texture.depthOrArrayLayers;
    this.format = descriptor.format ?? texture.format;
  }
  override get state(): RHIResourceState {
    const own = super.state;
    return own === 'live' ? this.texture.state : own;
  }
}

export class WebGL2Sampler extends WebGL2ResourceBase implements RHISampler {
  readonly kind = 'sampler';
  readonly descriptor: Readonly<RHISamplerDescriptor>;
  constructor(
    id: number,
    owner: WebGL2DeviceOwner,
    handle: WebGL2NativeObject,
    descriptor: RHISamplerDescriptor
  ) {
    super(id, owner, handle, descriptor.label);
    this.descriptor = Object.freeze({ ...descriptor });
  }
}

export function assertWebGL2Resource(
  resource: RHIResource,
  owner: WebGL2DeviceOwner
): WebGL2ResourceBase {
  if (!(resource instanceof WebGL2ResourceBase)) {
    throw new Error(
      `Resource "${resource.label ?? resource.kind}" was not created by WebGL2Device.`
    );
  }
  if (resource.owner !== owner)
    throw new Error(
      `Resource "${resource.label ?? resource.kind}" belongs to a different WebGL2Device.`
    );
  if (resource.state === 'disposed')
    throw new Error(`Resource "${resource.label ?? resource.kind}" has been disposed.`);
  if (resource.state === 'device-lost')
    throw new Error(`Resource "${resource.label ?? resource.kind}" belongs to a lost device.`);
  return resource;
}

export function getWebGL2Handle(
  resource: RHIResource,
  owner: WebGL2DeviceOwner
): WebGL2NativeObject {
  const wrapper = assertWebGL2Resource(resource, owner);
  const entry = nativeEntries.get(wrapper);
  if (entry === undefined)
    throw new Error(`Resource "${resource.label ?? resource.kind}" has no native WebGL2 handle.`);
  return entry.handle;
}

export function releaseWebGL2Native(
  native: WebGL2NativeContextPort,
  resource: WebGL2ResourceBase,
  handle: WebGL2NativeObject,
  owned: boolean
): void {
  if (!owned) return;
  if (resource.kind === 'buffer') native.deleteBuffer?.(handle);
  if (resource.kind === 'texture') native.deleteTexture?.(handle);
  if (resource.kind === 'sampler') native.deleteSampler?.(handle);
  if (resource.kind === 'render-pipeline') native.deleteProgram?.(handle);
}

export function normalizeExtent(size: GPUExtent3D) {
  if (typeof size === 'number')
    return Object.freeze({ width: size, height: 1, depthOrArrayLayers: 1 });
  if (Array.isArray(size)) {
    return Object.freeze({
      width: size[0] ?? 1,
      height: size[1] ?? 1,
      depthOrArrayLayers: size[2] ?? 1
    });
  }
  const value = size as { width: number; height?: number; depthOrArrayLayers?: number };
  return Object.freeze({
    width: value.width,
    height: value.height ?? 1,
    depthOrArrayLayers: value.depthOrArrayLayers ?? 1
  });
}

function freezeWithLabel<T extends object>(
  value: T,
  label: string | undefined
): Readonly<T & { label?: string }> {
  return Object.freeze(label === undefined ? value : { ...value, label });
}
