import type { RHIDeviceState, RHIResourceState } from '../lifecycle-types';
import type {
  GPUBindGroupDescriptor,
  GPUBufferBinding,
  GPUPipelineLayoutDescriptor,
  RHIBindGroup,
  RHIBindGroupLayout,
  RHIBuffer,
  RHIComputePipeline,
  RHIComputePipelineDescriptor,
  RHIPipelineLayout,
  RHIResource,
  RHIResourceKind,
  RHIRenderPipeline,
  RHIRenderPipelineDescriptor,
  RHISampler,
  RHIShaderModule,
  RHITexture,
  RHITextureView
} from '../resource-types';
import type {
  RHIBindGroupLayoutDescriptor,
  RHIBufferDescriptor,
  RHISamplerDescriptor,
  RHIShaderModuleDescriptor,
  RHITextureDescriptor,
  RHITextureViewDescriptor
} from '../descriptor-types';
import type { GPUExtent3D, GPUMapModeFlags } from '../webgpu-types';
import type { WebGPUNativeResourcePort, WebGPUNativeTexturePort } from './native-types';

const nativeHandles = new WeakMap<WebGPUResourceBase, WebGPUNativeResourcePort>();

export interface WebGPUDeviceOwner {
  readonly token: symbol;
  readonly generation: number;
  state: RHIDeviceState;
  allocateId(): number;
}

export abstract class WebGPUResourceBase implements RHIResource {
  protected disposed = false;
  abstract readonly kind: RHIResourceKind;

  constructor(
    readonly id: number,
    readonly owner: WebGPUDeviceOwner,
    nativeHandle: WebGPUNativeResourcePort,
    readonly label: string | undefined
  ) { nativeHandles.set(this, nativeHandle); }

  get generation(): number { return this.owner.generation; }
  get state(): RHIResourceState {
    if (this.owner.state !== 'live') return 'device-lost';
    return this.disposed ? 'disposed' : 'live';
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    nativeHandles.get(this)?.destroy?.();
  }
}

export class WebGPUBuffer extends WebGPUResourceBase implements RHIBuffer {
  readonly kind = 'buffer';
  readonly descriptor: Readonly<RHIBufferDescriptor>;
  readonly size: number;
  readonly usage: number;
  constructor(id: number, owner: WebGPUDeviceOwner, native: WebGPUNativeResourcePort, descriptor: RHIBufferDescriptor) {
    super(id, owner, native, descriptor.label);
    this.descriptor = freezeWithLabel({ size: descriptor.size, usage: descriptor.usage, mappedAtCreation: descriptor.mappedAtCreation ?? false }, descriptor.label);
    this.size = descriptor.size;
    this.usage = descriptor.usage;
  }
  async mapAsync(mode: GPUMapModeFlags, offset = 0, size = this.size - offset): Promise<void> {
    assertWebGPUResource(this, this.owner);
    const native = getWebGPUNativeHandle(this, this.owner);
    if (native.mapAsync === undefined) throw new Error('Native WebGPU buffer does not support mapAsync.');
    await native.mapAsync(mode, offset, size);
    assertWebGPUResource(this, this.owner);
  }
  getMappedRange(offset = 0, size = this.size - offset): ArrayBuffer {
    assertWebGPUResource(this, this.owner);
    const native = getWebGPUNativeHandle(this, this.owner);
    if (native.getMappedRange === undefined) throw new Error('Native WebGPU buffer does not expose a mapped range.');
    return native.getMappedRange(offset, size);
  }
  unmap(): void {
    assertWebGPUResource(this, this.owner);
    const native = getWebGPUNativeHandle(this, this.owner);
    if (native.unmap === undefined) throw new Error('Native WebGPU buffer does not support unmap.');
    native.unmap();
  }
}

export class WebGPUTexture extends WebGPUResourceBase implements RHITexture {
  readonly kind = 'texture';
  readonly descriptor: Readonly<RHITextureDescriptor>;
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly format: string;
  readonly usage: number;
  constructor(id: number, owner: WebGPUDeviceOwner, native: WebGPUNativeTexturePort, descriptor: RHITextureDescriptor) {
    super(id, owner, native, descriptor.label);
    const size = normalizeExtent(descriptor.size);
    this.descriptor = freezeWithLabel({
      size, format: descriptor.format, usage: descriptor.usage,
      dimension: descriptor.dimension ?? '2d', mipLevelCount: descriptor.mipLevelCount ?? 1,
      sampleCount: descriptor.sampleCount ?? 1
    }, descriptor.label);
    this.width = size.width;
    this.height = size.height;
    this.depthOrArrayLayers = size.depthOrArrayLayers;
    this.format = descriptor.format;
    this.usage = descriptor.usage;
  }
  createView(descriptor: RHITextureViewDescriptor = {}): RHITextureView {
    assertWebGPUResource(this, this.owner);
    const snapshot = Object.freeze({ ...descriptor });
    const native = (getWebGPUNativeHandle(this, this.owner) as WebGPUNativeTexturePort).createView(snapshot);
    return new WebGPUTextureView(this.owner.allocateId(), this.owner, native, this, snapshot);
  }
}

class WebGPUTextureView extends WebGPUResourceBase implements RHITextureView {
  readonly kind = 'texture-view';
  readonly descriptor: Readonly<RHITextureViewDescriptor>;
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly format: string;
  constructor(id: number, owner: WebGPUDeviceOwner, native: WebGPUNativeResourcePort, readonly texture: RHITexture, descriptor: RHITextureViewDescriptor) {
    super(id, owner, native, descriptor.label ?? texture.label);
    this.descriptor = Object.freeze({ ...descriptor });
    this.width = texture.width;
    this.height = texture.height;
    this.depthOrArrayLayers = descriptor.arrayLayerCount ?? texture.depthOrArrayLayers;
    this.format = descriptor.format ?? texture.format;
  }
  override get state(): RHIResourceState {
    const own = super.state;
    return own === 'live' ? this.texture.state : own;
  }
}

export class WebGPUSampler extends WebGPUResourceBase implements RHISampler {
  readonly kind = 'sampler';
  readonly descriptor: Readonly<RHISamplerDescriptor>;
  constructor(id: number, owner: WebGPUDeviceOwner, native: WebGPUNativeResourcePort, descriptor: RHISamplerDescriptor) {
    super(id, owner, native, descriptor.label);
    this.descriptor = Object.freeze({ ...descriptor });
  }
}

export class WebGPUShaderModule extends WebGPUResourceBase implements RHIShaderModule {
  readonly kind = 'shader-module';
  readonly descriptor: Readonly<RHIShaderModuleDescriptor>;
  constructor(id: number, owner: WebGPUDeviceOwner, native: WebGPUNativeResourcePort, descriptor: RHIShaderModuleDescriptor) {
    super(id, owner, native, descriptor.label);
    this.descriptor = Object.freeze({ ...descriptor });
  }
}

export class WebGPUBindGroupLayout extends WebGPUResourceBase implements RHIBindGroupLayout {
  readonly kind = 'bind-group-layout';
  readonly descriptor: Readonly<RHIBindGroupLayoutDescriptor>;
  readonly dynamicBindingCount: number;
  constructor(id: number, owner: WebGPUDeviceOwner, native: WebGPUNativeResourcePort, descriptor: RHIBindGroupLayoutDescriptor) {
    super(id, owner, native, descriptor.label);
    const entries = descriptor.entries.map((entry) => Object.freeze({ ...entry, ...(entry.buffer ? { buffer: Object.freeze({ ...entry.buffer }) } : {}) }));
    this.descriptor = freezeWithLabel({ entries: Object.freeze(entries) }, descriptor.label);
    this.dynamicBindingCount = entries.filter((entry) => entry.buffer?.hasDynamicOffset === true).length;
  }
  getEntry(binding: number) { return this.descriptor.entries.find((entry) => entry.binding === binding); }
}

export class WebGPUPipelineLayout extends WebGPUResourceBase implements RHIPipelineLayout {
  readonly kind = 'pipeline-layout';
  readonly descriptor: Readonly<GPUPipelineLayoutDescriptor>;
  readonly bindGroupLayouts: readonly RHIBindGroupLayout[];
  constructor(id: number, owner: WebGPUDeviceOwner, native: WebGPUNativeResourcePort, descriptor: GPUPipelineLayoutDescriptor) {
    super(id, owner, native, descriptor.label);
    this.bindGroupLayouts = Object.freeze([...descriptor.bindGroupLayouts]);
    this.descriptor = freezeWithLabel({ bindGroupLayouts: this.bindGroupLayouts }, descriptor.label);
  }
}

export class WebGPUBindGroup extends WebGPUResourceBase implements RHIBindGroup {
  readonly kind = 'bind-group';
  readonly descriptor: Readonly<GPUBindGroupDescriptor>;
  readonly layout: RHIBindGroupLayout;
  readonly dynamicBindingCount: number;
  constructor(id: number, owner: WebGPUDeviceOwner, native: WebGPUNativeResourcePort, descriptor: GPUBindGroupDescriptor) {
    super(id, owner, native, descriptor.label);
    this.layout = descriptor.layout;
    this.dynamicBindingCount = descriptor.layout.dynamicBindingCount;
    this.descriptor = freezeWithLabel({ entries: Object.freeze(descriptor.entries.map((entry) => Object.freeze({ ...entry }))), layout: descriptor.layout }, descriptor.label);
  }
}

export class WebGPURenderPipeline extends WebGPUResourceBase implements RHIRenderPipeline {
  readonly kind = 'render-pipeline';
  readonly descriptor: Readonly<RHIRenderPipelineDescriptor>;
  readonly layout: RHIPipelineLayout | undefined;
  readonly topology;
  constructor(id: number, owner: WebGPUDeviceOwner, native: WebGPUNativeResourcePort, descriptor: RHIRenderPipelineDescriptor) {
    super(id, owner, native, descriptor.label);
    this.layout = descriptor.layout;
    this.topology = descriptor.primitive?.topology;
    this.descriptor = snapshotRenderPipelineDescriptor(descriptor);
  }
}

export class WebGPUComputePipeline extends WebGPUResourceBase implements RHIComputePipeline {
  readonly kind = 'compute-pipeline';
  readonly descriptor: Readonly<RHIComputePipelineDescriptor>;
  readonly layout: RHIPipelineLayout | undefined;
  constructor(id: number, owner: WebGPUDeviceOwner, native: WebGPUNativeResourcePort, descriptor: RHIComputePipelineDescriptor) {
    super(id, owner, native, descriptor.label);
    this.layout = descriptor.layout;
    this.descriptor = Object.freeze({
      ...descriptor,
      ...(descriptor.compute === undefined ? {} : {
        compute: Object.freeze({
          ...descriptor.compute,
          ...(descriptor.compute.constants === undefined ? {} : { constants: Object.freeze({ ...descriptor.compute.constants }) })
        })
      })
    });
  }
}

export function assertWebGPUResource(resource: RHIResource, owner: WebGPUDeviceOwner): WebGPUResourceBase {
  if (!(resource instanceof WebGPUResourceBase)) throw new Error(`Resource "${resource.label ?? resource.kind}" was not created by WebGPUDevice.`);
  if (resource.owner !== owner) throw new Error(`Resource "${resource.label ?? resource.kind}" belongs to a different WebGPUDevice.`);
  if (resource.state === 'disposed') throw new Error(`Resource "${resource.label ?? resource.kind}" has been disposed.`);
  if (resource.state === 'device-lost') throw new Error(`Resource "${resource.label ?? resource.kind}" belongs to a lost device.`);
  return resource;
}

export function getWebGPUNativeHandle(resource: RHIResource, owner: WebGPUDeviceOwner): WebGPUNativeResourcePort {
  const wrapper = assertWebGPUResource(resource, owner);
  const native = nativeHandles.get(wrapper);
  if (native === undefined) throw new Error(`Resource "${resource.label ?? resource.kind}" has no native WebGPU handle.`);
  return native;
}

export function lowerBindingResource(resource: GPUBindGroupDescriptor['entries'][number]['resource'], owner: WebGPUDeviceOwner): unknown {
  if ('buffer' in resource) {
    const binding = resource as GPUBufferBinding;
    return { ...binding, buffer: getWebGPUNativeHandle(binding.buffer, owner) };
  }
  return getWebGPUNativeHandle(resource, owner);
}

export function normalizeExtent(size: GPUExtent3D) {
  if (typeof size === 'number') return Object.freeze({ width: size, height: 1, depthOrArrayLayers: 1 });
  if (!('width' in size)) return Object.freeze({ width: size[0] ?? 1, height: size[1] ?? 1, depthOrArrayLayers: size[2] ?? 1 });
  return Object.freeze({ width: size.width, height: size.height ?? 1, depthOrArrayLayers: size.depthOrArrayLayers ?? 1 });
}

function snapshotRenderPipelineDescriptor(descriptor: RHIRenderPipelineDescriptor): Readonly<RHIRenderPipelineDescriptor> {
  return Object.freeze({
    ...descriptor,
    ...(descriptor.vertex === undefined ? {} : { vertex: snapshotStage(descriptor.vertex) }),
    ...(descriptor.fragment === undefined ? {} : {
      fragment: Object.freeze({
        ...snapshotStage(descriptor.fragment),
        targets: Object.freeze(descriptor.fragment.targets.map((target) => target === null ? null : Object.freeze({
          ...target,
          ...(target.blend === undefined ? {} : { blend: Object.freeze({ color: Object.freeze({ ...target.blend.color }), alpha: Object.freeze({ ...target.blend.alpha }) }) })
        })))
      })
    }),
    ...(descriptor.primitive === undefined ? {} : { primitive: Object.freeze({ ...descriptor.primitive }) }),
    ...(descriptor.depthStencil === undefined ? {} : { depthStencil: Object.freeze({ ...descriptor.depthStencil }) }),
    ...(descriptor.multisample === undefined ? {} : { multisample: Object.freeze({ ...descriptor.multisample }) })
  });
}

function snapshotStage<T extends { module: RHIShaderModule; constants?: Readonly<Record<string, number>> }>(stage: T): T {
  return Object.freeze({
    ...stage,
    ...(stage.constants === undefined ? {} : { constants: Object.freeze({ ...stage.constants }) }),
    ...('buffers' in stage && Array.isArray(stage.buffers) ? {
      buffers: Object.freeze(stage.buffers.map((buffer) => buffer === null ? null : Object.freeze({
        ...buffer,
        attributes: Object.freeze(buffer.attributes.map(
          (attribute: { format: string; offset: number; shaderLocation: number }) => Object.freeze({ ...attribute })
        ))
      })))
    } : {})
  }) as T;
}

function freezeWithLabel<T extends object>(value: T, label: string | undefined): Readonly<T & { label?: string }> {
  return Object.freeze(label === undefined ? value : { ...value, label });
}
