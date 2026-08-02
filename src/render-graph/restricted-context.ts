import type { GraphAccess } from './builder';
import type { TextureGraphRange } from './ranges';
import type { GraphResourceRecord } from './resources';
import { toViewDescriptor } from './executor-resource-utils';
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
  GPUComputePassDescriptor,
  RHIBindGroup,
  RHIBindGroupLayout,
  RHIComputePassEncoder,
  RHIComputePipeline,
  RHIComputePipelineDescriptor,
  RHIDevice,
  RHIPipelineLayout,
  RHIRenderPipeline,
  RHIRenderPipelineDescriptor,
  RHISampler,
  RHIShaderModule,
  GPUVertexState,
  GPUFragmentState,
  GPUProgrammableStage,
  RHITextureView,
  RHIBuffer,
  RHITexture,
  RHISubmission
} from '../rhi/contracts';
import type { EndableRenderPass } from './executor-cleanup';
import {
  lowerRestrictedComputePipeline,
  lowerRestrictedRenderPipeline
} from './restricted-context-lowering';
import { resolveDeclaredResource } from './restricted-resource-resolution';
import { RestrictedResourceOwner } from './restricted-resource-owner';
import type {
  DeclaredRasterPass,
  RestrictedBindGroup,
  RestrictedBindGroupDescriptor,
  RestrictedBindGroupEntry,
  RestrictedBindGroupLayout,
  RestrictedBufferSlice,
  RestrictedComputePassEncoder,
  RestrictedComputePipeline,
  RestrictedComputePipelineDescriptor,
  RestrictedFragmentState,
  RestrictedPassContext,
  RestrictedPipelineLayout,
  RestrictedPortableDevice,
  RestrictedProgrammableStage,
  RestrictedRenderPassEncoder,
  RestrictedRenderPipeline,
  RestrictedRenderPipelineDescriptor,
  RestrictedSampler,
  RestrictedShaderModule,
  RestrictedTextureView,
  RestrictedVertexState
} from './restricted-context-types';

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
  private readonly samplers = new WeakMap<RestrictedSampler, RHISampler>();
  private readonly shaderModules = new WeakMap<RestrictedShaderModule, RHIShaderModule>();
  private readonly bindGroupLayouts = new WeakMap<RestrictedBindGroupLayout, RHIBindGroupLayout>();
  private readonly pipelineLayouts = new WeakMap<RestrictedPipelineLayout, RHIPipelineLayout>();
  private readonly bindGroups = new WeakMap<RestrictedBindGroup, RHIBindGroup>();
  private readonly renderPipelines = new WeakMap<RestrictedRenderPipeline, RHIRenderPipeline>();
  private readonly computePipelines = new WeakMap<RestrictedComputePipeline, RHIComputePipeline>();
  private readonly resourceOwner = new RestrictedResourceOwner((action) =>
    this.requireOpen(action)
  );
  private closed = false;
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

  /** Ends the synchronous callback capability window without disposing submission-owned objects. */
  close(): void {
    this.closed = true;
  }

  texture(handle: TextureHandle, usage: TextureUsage, range?: TextureRange): RestrictedTextureView {
    this.requireInactive('resolve a texture');
    const resolved = this.requiredTexture(handle, usage, range);
    const capability = Object.freeze({
      kind: 'restricted-texture-view' as const,
      range: resolved.range
    });
    this.textureCapabilities.set(capability, {
      view: this.resourceOwner.own(resolved.resource.createView(toViewDescriptor(resolved.range)))
    });
    return capability;
  }

  buffer(handle: BufferHandle, usage: BufferUsage, range?: BufferRange): RestrictedBufferSlice {
    this.requireInactive('resolve a buffer');
    const resolved = resolveDeclaredResource(
      this.accesses,
      this.resources,
      this.resourceRecords,
      handle,
      usage,
      range
    );
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

  beginRaster(descriptor: DeclaredRasterPass): RestrictedRenderPassEncoder {
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
    ) as unknown as RestrictedRenderPassEncoder;
  }

  beginCompute(descriptor: GPUComputePassDescriptor = {}): RestrictedComputePassEncoder {
    this.requireInactive('begin a compute pass');
    return this.track(
      this.encoder.beginComputePass(descriptor)
    ) as unknown as RestrictedComputePassEncoder;
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
    const device: RestrictedPortableDevice = {
      capabilities: this.rhiDevice.capabilities,
      generation: this.rhiDevice.generation,
      state: this.rhiDevice.state,
      lost: this.rhiDevice.lost,
      createSampler: (descriptor) => {
        this.requireOpen('create a sampler');
        const raw = this.resourceOwner.own(this.rhiDevice.createSampler(descriptor));
        const capability = Object.freeze({ kind: 'restricted-sampler' as const });
        this.samplers.set(capability, raw);
        return capability;
      },
      createShaderModule: (descriptor) => {
        this.requireOpen('create a shader module');
        const raw = this.resourceOwner.own(this.rhiDevice.createShaderModule(descriptor));
        const capability = Object.freeze({ kind: 'restricted-shader-module' as const });
        this.shaderModules.set(capability, raw);
        return capability;
      },
      createBindGroupLayout: (descriptor) => {
        const raw = this.resourceOwner.create('create a bind group layout', () =>
          this.rhiDevice.createBindGroupLayout(descriptor)
        );
        const capability = Object.freeze({ kind: 'restricted-bind-group-layout' as const });
        this.bindGroupLayouts.set(capability, raw);
        return capability;
      },
      createPipelineLayout: (descriptor) => {
        this.requireOpen('create a pipeline layout');
        const raw = this.resourceOwner.own(
          this.rhiDevice.createPipelineLayout({
            ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
            bindGroupLayouts: descriptor.bindGroupLayouts.map((layout) =>
              this.requiredCapability(
                this.bindGroupLayouts,
                layout,
                'Bind group layout is not owned by this render graph pass.'
              )
            )
          })
        );
        const capability = Object.freeze({ kind: 'restricted-pipeline-layout' as const });
        this.pipelineLayouts.set(capability, raw);
        return capability;
      },
      createBindGroup: (descriptor: RestrictedBindGroupDescriptor) => {
        this.requireOpen('create a bind group');
        const entries = descriptor.entries.map((entry) => ({
          binding: entry.binding,
          resource: this.bindingResource(entry.resource)
        }));
        const bindGroup = this.resourceOwner.own(
          this.rhiDevice.createBindGroup({
            ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
            layout: this.requiredCapability(
              this.bindGroupLayouts,
              descriptor.layout,
              'Bind group layout is not owned by this render graph pass.'
            ),
            entries
          })
        );
        const capability = Object.freeze({ kind: 'restricted-bind-group' as const });
        this.bindGroups.set(capability, bindGroup);
        return capability;
      },
      createRenderPipeline: (descriptor) => {
        const raw = this.resourceOwner.create('create a render pipeline', () =>
          this.rhiDevice.createRenderPipeline(
            lowerRestrictedRenderPipeline(
              descriptor,
              (layout) =>
                this.requiredCapability(
                  this.pipelineLayouts,
                  layout,
                  'Pipeline layout is not owned by this render graph pass.'
                ),
              (module) =>
                this.requiredCapability(
                  this.shaderModules,
                  module,
                  'Shader module is not owned by this render graph pass.'
                )
            )
          )
        );
        const capability = Object.freeze({ kind: 'restricted-render-pipeline' as const });
        this.renderPipelines.set(capability, raw);
        return capability;
      },
      createComputePipeline: (descriptor = {}) => {
        const raw = this.resourceOwner.create('create a compute pipeline', () =>
          this.rhiDevice.createComputePipeline(
            lowerRestrictedComputePipeline(
              descriptor,
              (layout) =>
                this.requiredCapability(
                  this.pipelineLayouts,
                  layout,
                  'Pipeline layout is not owned by this render graph pass.'
                ),
              (module) =>
                this.requiredCapability(
                  this.shaderModules,
                  module,
                  'Shader module is not owned by this render graph pass.'
                )
            )
          )
        );
        const capability = Object.freeze({ kind: 'restricted-compute-pipeline' as const });
        this.computePipelines.set(capability, raw);
        return capability;
      }
    };
    return Object.freeze(device);
  }

  /** Transfers pass-local object cleanup to the accepted submission's terminal boundary. */
  retireResources(submission: RHISubmission): void {
    this.resourceOwner.retire(submission);
  }

  /** Cleans up objects created before a submission was accepted. */
  disposeResources(): void {
    this.resourceOwner.disposeBeforeSubmit();
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
    return this.requiredCapability(
      this.samplers,
      resource,
      'Sampler is not owned by this render graph pass.'
    );
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
          return (index: number, bindGroup: RestrictedBindGroup, offsets?: readonly number[]) => {
            const rawBindGroup = this.bindGroups.get(bindGroup);
            if (rawBindGroup === undefined) {
              throw new Error(
                'Render graph pass can bind only groups created by its restricted device.'
              );
            }
            return (target as unknown as RHIComputePassEncoder).setBindGroup(
              index,
              rawBindGroup,
              offsets
            );
          };
        }
        if (property === 'setPipeline') {
          return (pipeline: RestrictedRenderPipeline | RestrictedComputePipeline) => {
            const rawPipeline =
              pipeline.kind === 'restricted-render-pipeline'
                ? this.renderPipelines.get(pipeline)
                : this.computePipelines.get(pipeline);
            if (rawPipeline === undefined) {
              throw new Error(
                'Render graph pass can use only pipelines created by its restricted device.'
              );
            }
            return (target as unknown as RHIComputePassEncoder).setPipeline(
              rawPipeline as RHIComputePipeline
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
    const resolved = resolveDeclaredResource(
      this.accesses,
      this.resources,
      this.resourceRecords,
      handle,
      usage,
      requestedRange
    );
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
    return this.resourceOwner.own(resolved.resource.createView(toViewDescriptor(resolved.range)));
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
    this.requireOpen(action);
    if (this.activePass !== undefined)
      throw new Error(`Cannot ${action} while a render graph pass encoder is active.`);
  }

  private requireOpen(action: string): void {
    if (this.closed)
      throw new Error(`Cannot ${action} after the render graph pass callback ended.`);
  }

  private requiredCapability<K extends object, V>(
    capabilities: WeakMap<K, V>,
    capability: K,
    message: string
  ): V {
    const raw = capabilities.get(capability);
    if (raw === undefined) throw new Error(message);
    return raw;
  }
}
