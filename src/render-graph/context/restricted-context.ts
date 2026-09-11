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
  RHIBindGroup,
  RHIBindGroupLayout,
  RHIComputePassEncoder,
  RHIComputePipeline,
  RHIDevice,
  RHIPipelineLayout,
  RHIRenderPassEncoder,
  RHIRenderPipeline,
  RHISampler,
  RHIShaderModule,
  RHITextureView,
  RHIBuffer,
  RHITexture,
  RHISubmission
} from '../../rhi/contracts';
import type {
  PreparedComputePipelineBindings,
  PreparedComputePipelineToken,
  PreparedBindGroupLayoutBindings,
  PreparedBindGroupLayoutToken,
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
  RestrictedBindGroup,
  RestrictedBindGroupEntry,
  RestrictedBindGroupLayout,
  RestrictedBufferSlice,
  RestrictedComputePipeline,
  RestrictedPreparedDrawResources,
  RestrictedPipelineLayout,
  RestrictedPortableDevice,
  RestrictedRenderPipeline,
  RestrictedSampler,
  RestrictedShaderModule,
  RestrictedTextureView
} from '../types';

interface TextureCapability {
  readonly view: RHITextureView;
}

/** @internal One-pass adapter over the executor-owned encoder and physical bindings. */
export class RestrictedContext {
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
  private readonly allowedRenderPipelines: ReadonlySet<PreparedRenderPipelineToken> | undefined;
  private readonly allowedComputePipelines: ReadonlySet<PreparedComputePipelineToken> | undefined;
  private readonly allowedDrawResources: ReadonlySet<PreparedDrawResourcesToken> | undefined;
  readonly device: RestrictedPortableDevice;

  constructor(
    private readonly accesses: readonly GraphAccess[],
    private readonly resources: ReadonlyMap<GraphHandle, RHITexture | RHIBuffer>,
    private readonly resourceRecords: ReadonlyMap<number, GraphResourceRecord>,
    private readonly rhiDevice: RHIDevice,
    private readonly preparedRenderPipelines: PreparedRenderPipelineBindings,
    private readonly preparedComputePipelines: PreparedComputePipelineBindings,
    private readonly preparedBindGroupLayouts: PreparedBindGroupLayoutBindings,
    private readonly preparedDrawResources: PreparedDrawResourcesBindings,
    private readonly encoder: ReturnType<RHIDevice['createCommandEncoder']>,
    declarations?: {
      readonly renderPipelines?: readonly PreparedRenderPipelineToken[];
      readonly computePipelines?: readonly PreparedComputePipelineToken[];
      readonly drawResources?: readonly PreparedDrawResourcesToken[];
    }
  ) {
    this.allowedRenderPipelines = declarations?.renderPipelines
      ? new Set(declarations.renderPipelines)
      : undefined;
    this.allowedComputePipelines = declarations?.computePipelines
      ? new Set(declarations.computePipelines)
      : undefined;
    this.allowedDrawResources = declarations?.drawResources
      ? new Set(declarations.drawResources)
      : undefined;
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

  renderPipeline(token: PreparedRenderPipelineToken): RestrictedRenderPipeline {
    this.requireInactive('resolve a prepared render pipeline');
    if (this.allowedRenderPipelines !== undefined && !this.allowedRenderPipelines.has(token)) {
      throw new Error(`Prepared render pipeline "${token.name}" was not declared during setup.`);
    }
    const raw = this.preparedRenderPipelines.get(token);
    if (raw === undefined)
      throw new Error(`Prepared render pipeline "${token.name}" is not bound.`);
    const capability = Object.freeze({ kind: 'restricted-render-pipeline' as const });
    this.renderPipelines.set(capability, raw);
    return capability;
  }

  computePipeline(token: PreparedComputePipelineToken): RestrictedComputePipeline {
    this.requireInactive('resolve a prepared compute pipeline');
    if (this.allowedComputePipelines !== undefined && !this.allowedComputePipelines.has(token)) {
      throw new Error(`Prepared compute pipeline "${token.name}" was not declared during setup.`);
    }
    const raw = this.preparedComputePipelines.get(token);
    if (raw === undefined)
      throw new Error(`Prepared compute pipeline "${token.name}" is not bound.`);
    const capability = Object.freeze({ kind: 'restricted-compute-pipeline' as const });
    this.computePipelines.set(capability, raw);
    return capability;
  }

  bindGroupLayout(token: PreparedBindGroupLayoutToken): RestrictedBindGroupLayout {
    this.requireInactive('resolve a prepared bind-group layout');
    const raw = this.preparedBindGroupLayouts.get(token);
    if (raw === undefined)
      throw new Error(`Prepared bind-group layout "${token.name}" is not bound.`);
    const capability = Object.freeze({ kind: 'restricted-bind-group-layout' as const });
    this.bindGroupLayouts.set(capability, raw);
    return capability;
  }

  drawResources(token: PreparedDrawResourcesToken): RestrictedPreparedDrawResources {
    this.requireInactive('resolve prepared draw resources');
    if (this.allowedDrawResources !== undefined && !this.allowedDrawResources.has(token)) {
      throw new Error(`Prepared draw resources "${token.name}" were not declared during setup.`);
    }
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

  /** Creates an unwrapping tracked proxy for an externally managed physical render pass. */
  createRenderPassProxy(pass: RHIRenderPassEncoder): unknown {
    return createTrackedPassProxy(pass, {
      bindGroups: this.bindGroups,
      renderPipelines: this.renderPipelines,
      computePipelines: this.computePipelines,
      bufferCapabilities: this.bufferCapabilities,
      onEnd: () => {}
    });
  }

  /** Creates an unwrapping tracked proxy for an externally managed physical compute pass. */
  createComputePassProxy(pass: RHIComputePassEncoder): unknown {
    return createTrackedPassProxy(pass, {
      bindGroups: this.bindGroups,
      renderPipelines: this.renderPipelines,
      computePipelines: this.computePipelines,
      bufferCapabilities: this.bufferCapabilities,
      onEnd: () => {}
    });
  }

  renderPipelineRequirements(pipeline: RestrictedRenderPipeline): {
    readonly bindGroupSlots: readonly number[];
    readonly vertexBufferSlots: readonly number[];
  } {
    const raw = this.renderPipelines.get(pipeline);
    if (raw === undefined) {
      throw new Error('Render pipeline is not owned by this render graph pass.');
    }
    return {
      bindGroupSlots: Object.freeze(
        raw.layout?.bindGroupLayouts.flatMap((layout, index) =>
          layout.descriptor.entries.length === 0 ? [] : [index]
        ) ?? []
      ),
      vertexBufferSlots: Object.freeze(
        (raw.descriptor.vertex?.buffers ?? []).flatMap((layout, index) =>
          layout === null || layout === undefined || layout.attributes.length === 0 ? [] : [index]
        )
      )
    };
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
