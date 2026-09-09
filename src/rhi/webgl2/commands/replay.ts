import type { GPUBindingResource, RHIBindGroup } from '../../contracts/resource';
import type { WebGL2IndexBufferState, WebGL2VertexBufferState } from '../state/cache-key';
import { WebGL2FramebufferCache } from '../state/framebuffer-cache';
import { WebGL2RenderPipeline } from '../pipeline/pipeline';
import { WebGL2Buffer, getWebGL2Handle } from '../resources/resource';
import type { WebGL2DeviceOwner } from '../types';
import type { WebGL2ImageCopyBuffer, WebGL2ImageCopyTexture, WebGL2ReplayCommand } from '../types';
import type { WebGL2Metrics } from '../metrics';
import type { WebGL2NativeContextPort } from '../types';
import { WebGL2StateVM } from '../state/state';
import { WebGL2VertexArrayCache } from '../state/vertex-array-cache';

interface BoundGroup {
  readonly group: RHIBindGroup;
  readonly dynamicOffsets: readonly number[];
}

export class WebGL2ReplayExecutor {
  readonly state: WebGL2StateVM;
  private pipeline: WebGL2RenderPipeline | undefined;
  private readonly groups = new Map<number, BoundGroup>();
  private readonly vertexBuffers = new Map<number, WebGL2VertexBufferState>();
  private indexBuffer: WebGL2IndexBufferState | undefined;
  private activePass: Readonly<Record<string, unknown>> | undefined;
  private activePassHasResolve = false;
  private readonly framebuffers: WebGL2FramebufferCache;
  private readonly vertexArrays: WebGL2VertexArrayCache;

  constructor(
    private readonly owner: WebGL2DeviceOwner,
    private readonly native: WebGL2NativeContextPort,
    private readonly metrics: WebGL2Metrics
  ) {
    this.state = new WebGL2StateVM(native, metrics);
    this.framebuffers = new WebGL2FramebufferCache(owner, native, metrics);
    this.vertexArrays = new WebGL2VertexArrayCache(owner, native, metrics);
  }

  execute(commands: readonly WebGL2ReplayCommand[]): void {
    for (const command of commands) this.executeCommand(command);
  }

  invalidateExternalState(): void {
    this.state.invalidate();
  }

  handleContextLoss(): void {
    this.state.invalidate();
    // A lost context invalidates these objects; issuing delete calls against it is neither useful nor safe.
    this.framebuffers.abandon();
    this.vertexArrays.abandon();
    this.pipeline = undefined;
    this.groups.clear();
    this.vertexBuffers.clear();
    this.indexBuffer = undefined;
    this.activePass = undefined;
    this.activePassHasResolve = false;
  }

  private executeCommand(command: WebGL2ReplayCommand): void {
    switch (command.kind) {
      case 'push-debug':
        return this.call('pushDebugGroup', command.label);
      case 'pop-debug':
        return this.call('popDebugGroup');
      case 'begin-render-pass':
        this.pipeline = undefined;
        this.groups.clear();
        this.vertexBuffers.clear();
        this.indexBuffer = undefined;
        this.activePass = this.framebuffers.lowerDescriptor(command.descriptor);
        this.activePassHasResolve = command.descriptor.colorAttachments.some(
          (attachment) => attachment.resolveTarget !== undefined
        );
        if (this.native.createFramebuffer !== undefined) {
          this.state.applyFramebuffer(this.framebuffers.getOrCreate(command.descriptor));
        }
        this.call('beginRenderPass', this.activePass);
        this.callOptional('applyRenderPassLoadOperations', this.activePass);
        return;
      case 'end-render-pass':
        if (this.activePass !== undefined) {
          this.callOptional('applyRenderPassStoreOperations', this.activePass);
          if (this.activePassHasResolve) this.callOptional('resolveRenderPass', this.activePass);
        }
        this.call('endRenderPass');
        this.activePass = undefined;
        this.activePassHasResolve = false;
        return;
      case 'set-pipeline':
        return this.applyPipeline(command.pipeline as WebGL2RenderPipeline);
      case 'set-bind-group': {
        const bound = { group: command.group, dynamicOffsets: command.dynamicOffsets };
        this.groups.set(command.index, bound);
        if (this.pipeline !== undefined) this.applyGroup(command.index, bound, this.pipeline);
        return;
      }
      case 'set-vertex-buffer':
        this.vertexBuffers.set(command.slot, {
          buffer: command.buffer as WebGL2Buffer,
          offset: command.offset,
          ...(command.size === undefined ? {} : { size: command.size })
        });
        if (this.native.createVertexArray === undefined) {
          return this.state.applyVertexBuffer(
            command.slot,
            getWebGL2Handle(command.buffer, this.owner),
            command.offset,
            command.size
          );
        }
        return;
      case 'set-index-buffer':
        this.indexBuffer = {
          buffer: command.buffer as WebGL2Buffer,
          format: command.indexFormat,
          offset: command.offset,
          ...(command.size === undefined ? {} : { size: command.size })
        };
        if (this.native.createVertexArray === undefined) {
          return this.state.applyIndexBuffer(
            getWebGL2Handle(command.buffer, this.owner),
            command.indexFormat,
            command.offset,
            command.size
          );
        }
        return;
      case 'set-viewport':
        return this.state.applyViewport([
          command.x,
          command.y,
          command.width,
          command.height,
          command.minDepth,
          command.maxDepth
        ]);
      case 'set-scissor':
        return this.state.applyScissor([command.x, command.y, command.width, command.height]);
      case 'draw':
        this.applyVertexArray();
        this.metrics.recordLogicalDraw();
        this.call(
          'draw',
          command.vertexCount,
          command.instanceCount,
          command.firstVertex,
          command.firstInstance
        );
        this.metrics.recordPhysicalDraw();
        return;
      case 'draw-indexed':
        this.applyVertexArray();
        this.metrics.recordLogicalDraw();
        this.call(
          'drawIndexed',
          command.indexCount,
          command.instanceCount,
          command.firstIndex,
          command.baseVertex,
          command.firstInstance
        );
        this.metrics.recordPhysicalDraw();
        return;
      case 'copy-buffer-to-buffer':
        return this.call(
          'copyBufferToBuffer',
          getWebGL2Handle(command.source, this.owner),
          command.sourceOffset,
          getWebGL2Handle(command.destination, this.owner),
          command.destinationOffset,
          command.size
        );
      case 'copy-texture-to-texture':
        return this.call(
          'copyTextureToTexture',
          lowerTextureCopy(command.source, this.owner),
          lowerTextureCopy(command.destination, this.owner),
          command.copySize
        );
      case 'copy-buffer-to-texture':
        return this.call(
          'copyBufferToTexture',
          lowerBufferCopy(command.source, this.owner),
          lowerTextureCopy(command.destination, this.owner),
          command.copySize
        );
      case 'copy-texture-to-buffer':
        return this.call(
          'copyTextureToBuffer',
          lowerTextureCopy(command.source, this.owner),
          lowerBufferCopy(command.destination, this.owner),
          command.copySize
        );
    }
  }

  private applyPipeline(pipeline: WebGL2RenderPipeline): void {
    this.pipeline = pipeline;
    this.state.applyProgram(getWebGL2Handle(pipeline, this.owner));
    const primitive = pipeline.descriptor.primitive;
    this.state.applyRasterState(
      pipeline.descriptor,
      Object.freeze({
        topology: primitive?.topology ?? 'triangle-list',
        stripIndexFormat: primitive?.stripIndexFormat,
        frontFace: primitive?.frontFace ?? 'ccw',
        cullMode: primitive?.cullMode ?? 'none'
      })
    );
    const depthStencil = pipeline.descriptor.depthStencil;
    this.state.applyDepthStencilState(
      pipeline.descriptor,
      depthStencil === undefined
        ? Object.freeze({ enabled: false })
        : Object.freeze({ enabled: true, ...depthStencil })
    );
    for (const [index, group] of this.groups) {
      const expectedLayout = pipeline.layout?.bindGroupLayouts[index];
      if (expectedLayout === undefined || group.group.layout !== expectedLayout) {
        this.groups.delete(index);
        continue;
      }
      this.applyGroup(index, group, pipeline);
    }
  }

  private applyVertexArray(): void {
    if (this.native.createVertexArray === undefined) return;
    if (this.pipeline === undefined) throw new Error('WebGL2 draw requires a current pipeline.');
    const vertexArray = this.vertexArrays.getOrCreate(
      this.pipeline,
      this.vertexBuffers,
      this.indexBuffer
    );
    this.state.applyVertexArray(vertexArray);
    if (this.indexBuffer !== undefined) {
      this.state.applyIndexBuffer(
        getWebGL2Handle(this.indexBuffer.buffer, this.owner),
        this.indexBuffer.format,
        this.indexBuffer.offset,
        this.indexBuffer.size
      );
    }
  }

  private applyGroup(index: number, bound: BoundGroup, pipeline: WebGL2RenderPipeline): void {
    const dynamicOffsets = dynamicOffsetMap(bound.group, bound.dynamicOffsets);
    for (const entry of bound.group.descriptor.entries) {
      const manifest = pipeline.bindings.find(
        (candidate) => candidate.group === index && candidate.binding === entry.binding
      );
      if (manifest === undefined)
        throw new Error(
          `WebGL2 pipeline has no binding for group ${index} binding ${entry.binding}.`
        );
      const physical = pipeline.physicalBindings.filter(
        (candidate) =>
          candidate.group === index &&
          candidate.binding === entry.binding &&
          candidate.kind === manifest.kind
      );
      if (physical.length === 0) {
        throw new Error(
          `WebGL2 pipeline has no physical slot for group ${index} binding ${entry.binding}.`
        );
      }
      for (const mapping of physical) {
        if (
          manifest.kind === 'texture' &&
          !pipeline.physicalBindings.some(
            (candidate) => candidate.kind === 'sampler' && candidate.slot === mapping.slot
          )
        ) {
          // Sampler bindings are context state and survive pipeline changes. Integer textures
          // must not inherit a filtering sampler left by an earlier combined-sampler draw.
          this.state.clearSampler(mapping.slot);
        }
        this.applyBinding(mapping.slot, entry.resource, dynamicOffsets.get(entry.binding) ?? 0);
      }
    }
  }

  private applyBinding(binding: number, resource: GPUBindingResource, dynamicOffset: number): void {
    if ('buffer' in resource) {
      const baseOffset = resource.offset ?? 0;
      const offset = baseOffset + dynamicOffset;
      const size = resource.size ?? resource.buffer.size - baseOffset;
      this.state.applyUniformBuffer(
        binding,
        getWebGL2Handle(resource.buffer, this.owner),
        offset,
        size
      );
      return;
    }
    const handle = getWebGL2Handle(resource, this.owner);
    if (resource.kind === 'texture-view') this.state.applyTexture(binding, handle);
    else this.state.applySampler(binding, handle);
  }

  private call(name: keyof WebGL2NativeContextPort, ...args: unknown[]): void {
    const operation = this.native[name];
    if (typeof operation !== 'function')
      throw new Error(`Native WebGL2 context does not support ${String(name)}.`);
    (operation as (...values: unknown[]) => void).call(this.native, ...args);
    this.metrics.recordGLCall();
  }

  private callOptional(name: keyof WebGL2NativeContextPort, ...args: unknown[]): void {
    const operation = this.native[name];
    if (typeof operation !== 'function') return;
    (operation as (...values: unknown[]) => void).call(this.native, ...args);
    this.metrics.recordGLCall();
  }
}

function lowerBufferCopy(copy: WebGL2ImageCopyBuffer, owner: WebGL2DeviceOwner) {
  return Object.freeze({
    buffer: getWebGL2Handle(copy.buffer, owner),
    offset: copy.offset,
    bytesPerRow: copy.bytesPerRow,
    rowsPerImage: copy.rowsPerImage
  });
}

function dynamicOffsetMap(
  group: RHIBindGroup,
  offsets: readonly number[]
): ReadonlyMap<number, number> {
  const result = new Map<number, number>();
  let index = 0;
  for (const entry of group.layout.descriptor.entries) {
    if (entry.buffer?.hasDynamicOffset === true) {
      result.set(entry.binding, offsets[index++]!);
    }
  }
  return result;
}

function lowerTextureCopy(
  copy: WebGL2ImageCopyTexture,
  owner: WebGL2DeviceOwner
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    texture: getWebGL2Handle(copy.texture, owner),
    mipLevel: copy.mipLevel,
    origin: copy.origin,
    aspect: copy.aspect
  });
}
