import type { GraphAccess } from '../builder/builder';
import type { TextureGraphRange } from '../compiler/ranges';
import type { GraphResourceRecord } from '../builder/resources';
import { toViewDescriptor } from '../executor/executor-resource-utils';
import type {
  BufferHandle,
  BufferRange,
  BufferUsage,
  GraphHandle,
  TextureHandle,
  TextureRange,
  TextureUsage
} from '../types';
import type {
  GPUComputePassDescriptor,
  RHIBindGroup,
  RHIBindGroupLayout,
  RHIComputePipeline,
  RHIDevice,
  RHIPipelineLayout,
  RHIRenderPipeline,
  RHISampler,
  RHIShaderModule,
  RHITextureView,
  RHIBuffer,
  RHITexture,
  RHISubmission
} from '../../rhi/contracts';
import type { EndableRenderPass } from '../executor/executor-cleanup';
import type {
  PreparedComputePipelineBindings,
  PreparedComputePipelineToken,
  PreparedDrawResourcesBindings,
  PreparedDrawResourcesToken,
  PreparedRenderPipelineBindings,
  PreparedRenderPipelineToken
} from '../builder/prepared-resources';
import { resolveDeclaredResource } from './restricted-resource-resolution';
import { RestrictedResourceOwner } from './restricted-resource-owner';
import { createTrackedPassProxy, type BufferCapability } from './restricted-encoder-proxy';
import { createRestrictedPortableDevice } from './restricted-device-factory';
import type {
  DeclaredRasterPass,
  RestrictedBindGroup,
  RestrictedBindGroupEntry,
  RestrictedBindGroupLayout,
  RestrictedBufferSlice,
  RestrictedComputePassEncoder,
  RestrictedComputePipeline,
  RestrictedPassContext,
  RestrictedPreparedDrawResources,
  RestrictedPipelineLayout,
  RestrictedPortableDevice,
  RestrictedRenderPassEncoder,
  RestrictedRenderPipeline,
  RestrictedSampler,
  RestrictedShaderModule,
  RestrictedTextureView
} from '../types';

interface TextureCapability {
  readonly view: RHITextureView;
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
    private readonly preparedRenderPipelines: PreparedRenderPipelineBindings,
    private readonly preparedComputePipelines: PreparedComputePipelineBindings,
    private readonly preparedDrawResources: PreparedDrawResourcesBindings,
    private readonly encoder: ReturnType<RHIDevice['createCommandEncoder']>,
    private readonly onBegin: (pass: ActivePass) => void,
    private readonly onEnd: () => void
  ) {
    this.device = createRestrictedPortableDevice({
      rhiDevice: this.rhiDevice,
      resourceOwner: this.resourceOwner,
      samplers: this.samplers,
      shaderModules: this.shaderModules,
      bindGroupLayouts: this.bindGroupLayouts,
      pipelineLayouts: this.pipelineLayouts,
      bindGroups: this.bindGroups,
      renderPipelines: this.renderPipelines,
      computePipelines: this.computePipelines,
      requireOpen: (action) => this.requireOpen(action),
      bindingResource: (resource) => this.bindingResource(resource)
    });
  }

  publicContext(): RestrictedPassContext {
    return Object.freeze({
      device: this.device,
      texture: this.texture.bind(this),
      buffer: this.buffer.bind(this),
      renderPipeline: this.renderPipeline.bind(this),
      computePipeline: this.computePipeline.bind(this),
      drawResources: this.drawResources.bind(this),
      beginRaster: this.beginRaster.bind(this),
      beginCompute: this.beginCompute.bind(this),
      copyBufferToBuffer: this.copyBufferToBuffer.bind(this)
    });
  }

  renderPipeline(token: PreparedRenderPipelineToken): RestrictedRenderPipeline {
    this.requireInactive('resolve a prepared render pipeline');
    const raw = this.preparedRenderPipelines.get(token);
    if (raw === undefined)
      throw new Error(`Prepared render pipeline "${token.name}" is not bound.`);
    const capability = Object.freeze({ kind: 'restricted-render-pipeline' as const });
    this.renderPipelines.set(capability, raw);
    return capability;
  }

  computePipeline(token: PreparedComputePipelineToken): RestrictedComputePipeline {
    this.requireInactive('resolve a prepared compute pipeline');
    const raw = this.preparedComputePipelines.get(token);
    if (raw === undefined)
      throw new Error(`Prepared compute pipeline "${token.name}" is not bound.`);
    const capability = Object.freeze({ kind: 'restricted-compute-pipeline' as const });
    this.computePipelines.set(capability, raw);
    return capability;
  }

  drawResources(token: PreparedDrawResourcesToken): RestrictedPreparedDrawResources {
    this.requireInactive('resolve prepared draw resources');
    const packet = this.preparedDrawResources.get(token);
    if (packet === undefined)
      throw new Error(`Prepared draw resources "${token.name}" are not bound.`);
    const pipeline = Object.freeze({ kind: 'restricted-render-pipeline' as const });
    this.renderPipelines.set(pipeline, packet.pipeline);
    const bindGroups = packet.bindingSet.bindGroups.map((raw) => {
      const capability = Object.freeze({ kind: 'restricted-bind-group' as const });
      this.bindGroups.set(capability, raw);
      return capability;
    });
    const vertexBuffers = packet.vertexBuffers.map((raw) => this.preparedBuffer(raw, 'vertex'));
    return Object.freeze({
      pipeline,
      bindGroups: Object.freeze(bindGroups),
      dynamicOffsetsByGroup: Object.freeze(
        packet.bindingSet.dynamicOffsetsByGroup.map((offsets) => Object.freeze([...offsets]))
      ),
      vertexBuffers: Object.freeze(vertexBuffers),
      indexBuffer: this.preparedBuffer(packet.indexBuffer, 'index'),
      indexFormat: packet.indexFormat,
      firstIndex: packet.firstIndex,
      indexCount: packet.indexCount
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
    const tracked = createTrackedPassProxy(pass, {
      bindGroups: this.bindGroups,
      renderPipelines: this.renderPipelines,
      computePipelines: this.computePipelines,
      bufferCapabilities: this.bufferCapabilities,
      onEnd: () => {
        this.activePass = undefined;
        this.onEnd();
      }
    });
    this.activePass = tracked;
    this.onBegin(tracked);
    return tracked;
  }

  private preparedBuffer(buffer: RHIBuffer, usage: 'vertex' | 'index'): RestrictedBufferSlice {
    const capability = Object.freeze({
      kind: 'restricted-buffer-slice' as const,
      offset: 0,
      size: buffer.size
    });
    this.bufferCapabilities.set(capability, { buffer, usage, offset: 0, size: buffer.size });
    return capability;
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
