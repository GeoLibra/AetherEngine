import type { GraphAccess } from './builder';
import type { GraphRange, TextureGraphRange } from './ranges';
import type { GraphResourceRecord } from './resources';
import {
  containsRange,
  normalizeRequestedRange,
  toViewDescriptor
} from './executor-resource-utils';
import type {
  BufferHandle,
  BufferRange,
  BufferUsage,
  GraphHandle,
  TextureHandle,
  TextureRange,
  TextureUsage
} from './types';
import type {
  GPUColor,
  GPUComputePassDescriptor,
  GPULoadOp,
  GPUStoreOp,
  RHIBindGroup,
  RHIBindGroupLayout,
  GPUBindGroupLayoutDescriptor,
  RHIComputePassEncoder,
  RHIComputePipeline,
  RHIComputePipelineDescriptor,
  RHIDevice,
  RHIPipelineLayout,
  GPUPipelineLayoutDescriptor,
  RHIRenderPassEncoder,
  RHIRenderPipeline,
  RHIRenderPipelineDescriptor,
  RHISampler,
  GPUSamplerDescriptor,
  RHIShaderModule,
  GPUShaderModuleDescriptor,
  RHITextureView,
  RHIBuffer,
  RHITexture
} from '../rhi/contracts';
import type { EndableRenderPass } from './executor-cleanup';

export interface DeclaredRasterColorAttachment {
  readonly texture: TextureHandle;
  readonly range?: TextureRange;
  readonly loadOp: GPULoadOp;
  readonly storeOp: GPUStoreOp;
  readonly clearValue?: GPUColor;
}

export interface DeclaredRasterDepthStencilAttachment {
  readonly texture: TextureHandle;
  readonly range?: TextureRange;
  readonly depthLoadOp?: GPULoadOp;
  readonly depthStoreOp?: GPUStoreOp;
  readonly depthClearValue?: number;
  readonly stencilLoadOp?: GPULoadOp;
  readonly stencilStoreOp?: GPUStoreOp;
  readonly stencilClearValue?: number;
}

export interface DeclaredRasterPass {
  readonly label?: string;
  readonly colorAttachments: readonly DeclaredRasterColorAttachment[];
  readonly depthStencilAttachment?: DeclaredRasterDepthStencilAttachment;
}

export interface RestrictedBindGroupEntry {
  readonly binding: number;
  readonly resource: RestrictedTextureView | RestrictedBufferSlice | RHISampler;
}

export interface RestrictedBindGroupDescriptor {
  readonly label?: string;
  readonly layout: RHIBindGroupLayout;
  readonly entries: readonly RestrictedBindGroupEntry[];
}

/** Portable creation only: no queue, resource allocation, command encoder, native extension, or destroy. */
export interface RestrictedPortableDevice {
  readonly capabilities: RHIDevice['capabilities'];
  readonly generation: RHIDevice['generation'];
  readonly state: RHIDevice['state'];
  readonly lost: RHIDevice['lost'];
  createSampler(descriptor?: GPUSamplerDescriptor): RHISampler;
  createShaderModule(descriptor: GPUShaderModuleDescriptor): RHIShaderModule;
  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): RHIBindGroupLayout;
  createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): RHIPipelineLayout;
  createBindGroup(descriptor: RestrictedBindGroupDescriptor): RHIBindGroup;
  createRenderPipeline(descriptor: RHIRenderPipelineDescriptor): RHIRenderPipeline;
  createComputePipeline(descriptor?: RHIComputePipelineDescriptor): RHIComputePipeline;
}

/** The only GPU capability visible to a user render-pass callback. */
export interface RestrictedPassContext {
  readonly device: RestrictedPortableDevice;
  texture(handle: TextureHandle, usage: TextureUsage, range?: TextureRange): RestrictedTextureView;
  buffer(handle: BufferHandle, usage: BufferUsage, range?: BufferRange): RestrictedBufferSlice;
  beginRaster(descriptor: DeclaredRasterPass): RHIRenderPassEncoder;
  beginCompute(descriptor?: GPUComputePassDescriptor): RHIComputePassEncoder;
  copyBufferToBuffer(
    source: RestrictedBufferSlice,
    destination: RestrictedBufferSlice,
    size?: number
  ): void;
}

/** Opaque but usable view capability; only the restricted device can lower it for binding. */
export interface RestrictedTextureView {
  readonly kind: 'restricted-texture-view';
  readonly range: TextureGraphRange;
}

/** Opaque but usable slice capability; copy and binding lower exactly this declared interval. */
export interface RestrictedBufferSlice {
  readonly kind: 'restricted-buffer-slice';
  readonly offset: number;
  readonly size: number;
}

interface TextureCapability {
  readonly view: RHITextureView;
}

interface BufferCapability {
  readonly buffer: RHIBuffer;
  readonly usage: BufferUsage;
  readonly offset: number;
  readonly size: number;
}

type ActivePass = EndableRenderPass;

/** @internal One-pass adapter over the executor-owned encoder and physical bindings. */
export class RestrictedContext implements RestrictedPassContext {
  private activePass: ActivePass | undefined;
  private readonly textureCapabilities = new WeakMap<RestrictedTextureView, TextureCapability>();
  private readonly bufferCapabilities = new WeakMap<RestrictedBufferSlice, BufferCapability>();
  private readonly bindGroups = new WeakSet<RHIBindGroup>();
  readonly device: RestrictedPortableDevice;

  constructor(
    private readonly accesses: readonly GraphAccess[],
    private readonly resources: ReadonlyMap<GraphHandle, RHITexture | RHIBuffer>,
    private readonly resourceRecords: ReadonlyMap<number, GraphResourceRecord>,
    private readonly rhiDevice: RHIDevice,
    private readonly encoder: ReturnType<RHIDevice['createCommandEncoder']>,
    private readonly onBegin: (pass: ActivePass) => void,
    private readonly onEnd: () => void
  ) {
    this.device = this.createPortableDevice();
  }

  publicContext(): RestrictedPassContext {
    return Object.freeze({
      device: this.device,
      texture: this.texture.bind(this),
      buffer: this.buffer.bind(this),
      beginRaster: this.beginRaster.bind(this),
      beginCompute: this.beginCompute.bind(this),
      copyBufferToBuffer: this.copyBufferToBuffer.bind(this)
    });
  }

  texture(handle: TextureHandle, usage: TextureUsage, range?: TextureRange): RestrictedTextureView {
    this.requireInactive('resolve a texture');
    const resolved = this.requiredTexture(handle, usage, range);
    const capability = Object.freeze({
      kind: 'restricted-texture-view' as const,
      range: resolved.range
    });
    this.textureCapabilities.set(capability, {
      view: resolved.resource.createView(toViewDescriptor(resolved.range))
    });
    return capability;
  }

  buffer(handle: BufferHandle, usage: BufferUsage, range?: BufferRange): RestrictedBufferSlice {
    this.requireInactive('resolve a buffer');
    const resolved = this.requiredResource(handle, usage, range);
    if (resolved.resource.kind !== 'buffer')
      throw new Error('Render graph buffer handle resolved to a texture.');
    if (resolved.range.kind !== 'buffer') throw new Error('Render graph buffer range is invalid.');
    const capability = Object.freeze({
      kind: 'restricted-buffer-slice' as const,
      offset: resolved.range.offset,
      size: resolved.range.size
    });
    this.bufferCapabilities.set(capability, {
      buffer: resolved.resource,
      usage,
      offset: resolved.range.offset,
      size: resolved.range.size
    });
    return capability;
  }

  beginRaster(descriptor: DeclaredRasterPass): RHIRenderPassEncoder {
    this.requireInactive('begin a raster pass');
    const colorAttachments = descriptor.colorAttachments.map((attachment) => ({
      view: this.textureView(attachment.texture, 'color-attachment', attachment.range),
      loadOp: attachment.loadOp,
      storeOp: attachment.storeOp,
      ...(attachment.clearValue === undefined ? {} : { clearValue: attachment.clearValue })
    }));
    const depth = descriptor.depthStencilAttachment;
    const depthStencilAttachment =
      depth === undefined
        ? undefined
        : {
            view: this.textureView(depth.texture, 'depth-stencil-attachment', depth.range),
            ...(depth.depthLoadOp === undefined ? {} : { depthLoadOp: depth.depthLoadOp }),
            ...(depth.depthStoreOp === undefined ? {} : { depthStoreOp: depth.depthStoreOp }),
            ...(depth.depthClearValue === undefined
              ? {}
              : { depthClearValue: depth.depthClearValue }),
            ...(depth.stencilLoadOp === undefined ? {} : { stencilLoadOp: depth.stencilLoadOp }),
            ...(depth.stencilStoreOp === undefined ? {} : { stencilStoreOp: depth.stencilStoreOp }),
            ...(depth.stencilClearValue === undefined
              ? {}
              : { stencilClearValue: depth.stencilClearValue })
          };
    return this.track(
      this.encoder.beginRenderPass({
        ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
        colorAttachments,
        ...(depthStencilAttachment === undefined ? {} : { depthStencilAttachment })
      })
    );
  }

  beginCompute(descriptor: GPUComputePassDescriptor = {}): RHIComputePassEncoder {
    this.requireInactive('begin a compute pass');
    return this.track(this.encoder.beginComputePass(descriptor));
  }

  copyBufferToBuffer(
    source: RestrictedBufferSlice,
    destination: RestrictedBufferSlice,
    size?: number
  ): void {
    this.requireInactive('copy buffers');
    const sourceBinding = this.requiredBufferCapability(source, 'copy-src');
    const destinationBinding = this.requiredBufferCapability(destination, 'copy-dst');
    const copySize = size ?? Math.min(sourceBinding.size, destinationBinding.size);
    if (
      !Number.isSafeInteger(copySize) ||
      copySize < 0 ||
      copySize > sourceBinding.size ||
      copySize > destinationBinding.size
    ) {
      throw new Error('Render graph buffer copy size is outside the declared slices.');
    }
    this.encoder.copyBufferToBuffer(
      sourceBinding.buffer,
      sourceBinding.offset,
      destinationBinding.buffer,
      destinationBinding.offset,
      copySize
    );
  }

  private createPortableDevice(): RestrictedPortableDevice {
    return Object.freeze({
      capabilities: this.rhiDevice.capabilities,
      generation: this.rhiDevice.generation,
      state: this.rhiDevice.state,
      lost: this.rhiDevice.lost,
      createSampler: this.rhiDevice.createSampler.bind(this.rhiDevice),
      createShaderModule: this.rhiDevice.createShaderModule.bind(this.rhiDevice),
      createBindGroupLayout: this.rhiDevice.createBindGroupLayout.bind(this.rhiDevice),
      createPipelineLayout: this.rhiDevice.createPipelineLayout.bind(this.rhiDevice),
      createBindGroup: (descriptor: RestrictedBindGroupDescriptor) => {
        const entries = descriptor.entries.map((entry) => ({
          binding: entry.binding,
          resource: this.bindingResource(entry.resource)
        }));
        const bindGroup = this.rhiDevice.createBindGroup({
          ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
          layout: descriptor.layout,
          entries
        });
        this.bindGroups.add(bindGroup);
        return bindGroup;
      },
      createRenderPipeline: this.rhiDevice.createRenderPipeline.bind(this.rhiDevice),
      createComputePipeline: this.rhiDevice.createComputePipeline.bind(this.rhiDevice)
    });
  }

  private bindingResource(resource: RestrictedBindGroupEntry['resource']) {
    if (resource.kind === 'restricted-texture-view') {
      const capability = this.textureCapabilities.get(resource);
      if (capability === undefined)
        throw new Error('Texture view is not owned by this render graph pass.');
      return capability.view;
    }
    if (resource.kind === 'restricted-buffer-slice') {
      const capability = this.bufferCapabilities.get(resource);
      if (capability === undefined)
        throw new Error('Buffer slice is not owned by this render graph pass.');
      return { buffer: capability.buffer, offset: capability.offset, size: capability.size };
    }
    return resource;
  }

  private track<T extends ActivePass>(pass: T): T {
    const end = pass.end.bind(pass);
    let ended = false;
    const tracked = new Proxy(pass, {
      get: (target, property) => {
        if (property === 'end') {
          return () => {
            if (ended) throw new Error('Render graph pass encoder has already ended.');
            ended = true;
            end();
            this.activePass = undefined;
            this.onEnd();
          };
        }
        if (property === 'setBindGroup') {
          return (index: number, bindGroup: RHIBindGroup, offsets?: readonly number[]) => {
            if (!this.bindGroups.has(bindGroup)) {
              throw new Error(
                'Render graph pass can bind only groups created by its restricted device.'
              );
            }
            return (target as unknown as RHIComputePassEncoder).setBindGroup(
              index,
              bindGroup,
              offsets
            );
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    this.activePass = tracked;
    this.onBegin(tracked);
    return tracked;
  }

  private requiredTexture(
    handle: TextureHandle,
    usage: TextureUsage,
    requestedRange: TextureRange | undefined
  ): { readonly resource: RHITexture; readonly range: TextureGraphRange } {
    const resolved = this.requiredResource(handle, usage, requestedRange);
    if (resolved.resource.kind !== 'texture')
      throw new Error('Render graph texture handle resolved to a buffer.');
    if (resolved.range.kind !== 'texture')
      throw new Error('Render graph texture range is invalid.');
    return { resource: resolved.resource, range: resolved.range };
  }

  private textureView(
    handle: TextureHandle,
    usage: TextureUsage,
    requestedRange: TextureRange | undefined
  ): RHITextureView {
    const resolved = this.requiredTexture(handle, usage, requestedRange);
    return resolved.resource.createView(toViewDescriptor(resolved.range));
  }

  private requiredResource(
    handle: GraphHandle,
    usage: TextureUsage | BufferUsage,
    requestedRange: TextureRange | BufferRange | undefined
  ): { readonly resource: RHITexture | RHIBuffer; readonly range: GraphRange } {
    const candidates = this.accesses.filter(
      (candidate) => candidate.handle === handle && candidate.usage === usage
    );
    if (candidates.length === 0) {
      const declared = this.accesses.some((candidate) => candidate.handle === handle);
      throw new Error(
        declared
          ? `Render graph resource usage "${usage}" is not declared for this pass.`
          : 'Render graph resource is not declared for this pass.'
      );
    }
    const record = this.resourceRecords.get(handle.resourceId);
    if (record === undefined)
      throw new Error(`Render graph resource ${handle.resourceId} has no descriptor.`);
    const range =
      requestedRange === undefined
        ? candidates.length === 1
          ? candidates[0]!.range
          : undefined
        : normalizeRequestedRange(handle, requestedRange, record.descriptor);
    if (range === undefined) {
      throw new Error(
        'Render graph resource has multiple declarations; an explicit range is required.'
      );
    }
    if (!candidates.some((candidate) => containsRange(candidate.range, range))) {
      throw new Error('Render graph resource range is outside this pass declaration.');
    }
    const resource = this.resources.get(handle);
    if (resource === undefined)
      throw new Error(
        `Render graph resource ${handle.resourceId} version ${handle.version} has no physical binding.`
      );
    return { resource, range };
  }

  private requiredBufferCapability(
    capability: RestrictedBufferSlice,
    usage: 'copy-src' | 'copy-dst'
  ): BufferCapability {
    const binding = this.bufferCapabilities.get(capability);
    if (binding === undefined)
      throw new Error('Buffer slice is not owned by this render graph pass.');
    if (binding.usage !== usage)
      throw new Error(`Render graph buffer slice requires ${usage} usage.`);
    return binding;
  }

  private requireInactive(action: string): void {
    if (this.activePass !== undefined)
      throw new Error(`Cannot ${action} while a render graph pass encoder is active.`);
  }
}
