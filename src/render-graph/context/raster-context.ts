import type { GPUColor, RHIRenderPassEncoder } from '../../rhi/contracts';
import type {
  BufferHandle,
  BufferRange,
  BufferUsage,
  RasterCommands,
  RasterPassContext,
  RestrictedBindGroup,
  RestrictedBufferSlice,
  RestrictedPreparedDrawResources,
  RestrictedPortableDevice,
  RestrictedRenderPipeline,
  RestrictedTextureView,
  TextureHandle,
  PreparedBindGroupLayoutToken,
  PreparedComputePipelineToken,
  PreparedDrawResourcesToken,
  PreparedRenderPipelineToken,
  TextureRange,
  TextureUsage
} from '../types';
import type { RestrictedContext } from './restricted-context';

export class RasterPassScope {
  private active = true;
  readonly scopeId = Symbol('RasterPassScope');

  revoke(): void {
    this.active = false;
  }

  assertActive(): void {
    if (!this.active) {
      throw new Error('Cannot invoke raster commands outside of the active pass callback scope.');
    }
  }

  isActive(): boolean {
    return this.active;
  }
}

export interface UnderlyingRenderPass {
  setPipeline(pipeline: RestrictedRenderPipeline): void;
  setBindGroup(
    index: number,
    bindGroup: RestrictedBindGroup,
    dynamicOffsets?: readonly number[]
  ): void;
  setVertexBuffer(
    slot: number,
    buffer: RestrictedBufferSlice,
    offset?: number,
    size?: number
  ): void;
  setIndexBuffer(
    buffer: RestrictedBufferSlice,
    format: 'uint16' | 'uint32',
    offset?: number,
    size?: number
  ): void;
  setViewport(
    x: number,
    y: number,
    width: number,
    height: number,
    minDepth?: number,
    maxDepth?: number
  ): void;
  setScissorRect(x: number, y: number, width: number, height: number): void;
  setBlendConstant?(color: GPUColor): void;
  setStencilReference?(reference: number): void;
  draw(
    vertexCount: number,
    instanceCount?: number,
    firstVertex?: number,
    firstInstance?: number
  ): void;
  drawIndexed(
    indexCount: number,
    instanceCount?: number,
    firstIndex?: number,
    baseVertex?: number,
    firstInstance?: number
  ): void;
  drawIndirect?(indirectBuffer: RestrictedBufferSlice, indirectOffset: number): void;
}

export class RasterCommandsImpl implements RasterCommands {
  private currentPipeline?: RestrictedRenderPipeline | undefined;
  private hasIndexBuffer = false;

  /**
   * Epoch identity for logical pass state isolation.
   * Incremented each time setPipeline is called, ensuring bindings
   * cannot leak across logical pass boundaries within a fused physical pass.
   */
  private logicalPassEpoch = 0;
  private readonly bindGroupEpochs = new Map<number, number>();
  private readonly vertexBufferEpochs = new Map<number, number>();
  private indexBufferEpoch = -1;
  private requiredBindGroupSlots: readonly number[] = [];
  private requiredVertexBufferSlots: readonly number[] = [];

  constructor(
    private readonly pass: UnderlyingRenderPass,
    private readonly scope: RasterPassScope,
    private readonly pipelineRequirements: (pipeline: RestrictedRenderPipeline) => {
      readonly bindGroupSlots: readonly number[];
      readonly vertexBufferSlots: readonly number[];
    }
  ) {}

  setPipeline = (pipeline: RestrictedRenderPipeline): void => {
    this.scope.assertActive();
    // Start a new logical pass epoch: previous bindings are no longer valid
    this.logicalPassEpoch++;
    this.currentPipeline = pipeline;
    const requirements = this.pipelineRequirements(pipeline);
    this.requiredBindGroupSlots = requirements.bindGroupSlots;
    this.requiredVertexBufferSlots = requirements.vertexBufferSlots;
    this.pass.setPipeline(pipeline);
  };

  setBindGroup = (
    index: number,
    bindGroup: RestrictedBindGroup,
    dynamicOffsets?: readonly number[]
  ): void => {
    this.scope.assertActive();
    this.bindGroupEpochs.set(index, this.logicalPassEpoch);
    this.pass.setBindGroup(index, bindGroup, dynamicOffsets);
  };

  setVertexBuffer = (
    slot: number,
    buffer: RestrictedBufferSlice,
    offset?: number,
    size?: number
  ): void => {
    this.scope.assertActive();
    this.vertexBufferEpochs.set(slot, this.logicalPassEpoch);
    this.pass.setVertexBuffer(slot, buffer, offset, size);
  };

  setIndexBuffer = (
    buffer: RestrictedBufferSlice,
    format: 'uint16' | 'uint32',
    offset?: number,
    size?: number
  ): void => {
    this.scope.assertActive();
    this.hasIndexBuffer = true;
    this.indexBufferEpoch = this.logicalPassEpoch;
    this.pass.setIndexBuffer(buffer, format, offset, size);
  };

  setViewport = (
    x: number,
    y: number,
    width: number,
    height: number,
    minDepth?: number,
    maxDepth?: number
  ): void => {
    this.scope.assertActive();
    this.pass.setViewport(x, y, width, height, minDepth, maxDepth);
  };

  setScissorRect = (x: number, y: number, width: number, height: number): void => {
    this.scope.assertActive();
    this.pass.setScissorRect(x, y, width, height);
  };

  setBlendConstant = (color: GPUColor): void => {
    this.scope.assertActive();
    this.pass.setBlendConstant?.(color);
  };

  setStencilReference = (reference: number): void => {
    this.scope.assertActive();
    this.pass.setStencilReference?.(reference);
  };

  draw = (vertexCount: number, instanceCount = 1, firstVertex = 0, firstInstance = 0): void => {
    this.scope.assertActive();
    if (this.currentPipeline === undefined) {
      throw new Error('Draw requires setPipeline() to be called within the logical pass scope.');
    }
    this.validateLogicalBindings('draw');
    this.pass.draw(vertexCount, instanceCount, firstVertex, firstInstance);
  };

  drawIndexed = (
    indexCount: number,
    instanceCount = 1,
    firstIndex = 0,
    baseVertex = 0,
    firstInstance = 0
  ): void => {
    this.scope.assertActive();
    if (this.currentPipeline === undefined) {
      throw new Error(
        'DrawIndexed requires setPipeline() to be called within the logical pass scope.'
      );
    }
    if (!this.hasIndexBuffer) {
      throw new Error(
        'DrawIndexed requires setIndexBuffer() to be called after the most recent setPipeline() within the logical pass scope.'
      );
    }
    if (this.indexBufferEpoch !== this.logicalPassEpoch) {
      throw new Error(
        'DrawIndexed requires setIndexBuffer() to be called after the most recent setPipeline() within the logical pass scope.'
      );
    }
    this.validateLogicalBindings('drawIndexed');
    this.pass.drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
  };

  drawIndirect = (indirectBuffer: RestrictedBufferSlice, indirectOffset: number): void => {
    this.scope.assertActive();
    if (this.currentPipeline === undefined) {
      throw new Error(
        'DrawIndirect requires setPipeline() to be called within the logical pass scope.'
      );
    }
    this.validateLogicalBindings('drawIndirect');
    this.pass.drawIndirect?.(indirectBuffer, indirectOffset);
  };

  /**
   * Validates that bind groups and vertex buffers were set in the current logical pass epoch.
   * Prevents cross-logical-pass state leaks in fused physical passes.
   */
  private validateLogicalBindings(operation: string): void {
    // Validate bind groups
    for (const index of this.requiredBindGroupSlots) {
      const epoch = this.bindGroupEpochs.get(index);
      if (epoch !== this.logicalPassEpoch) {
        throw new Error(
          `${operation} requires setBindGroup(${index}) to be called after the most recent setPipeline() within the logical pass scope. ` +
            `Bindings from previous logical passes cannot satisfy current pass requirements.`
        );
      }
    }

    // Validate vertex buffers
    for (const slot of this.requiredVertexBufferSlots) {
      const epoch = this.vertexBufferEpochs.get(slot);
      if (epoch !== this.logicalPassEpoch) {
        throw new Error(
          `${operation} requires setVertexBuffer(${slot}) to be called after the most recent setPipeline() within the logical pass scope. ` +
            `Vertex buffers from previous logical passes cannot satisfy current pass requirements.`
        );
      }
    }
  }
}

export class RasterPassContextImpl implements RasterPassContext {
  readonly raster: RasterCommands;
  private readonly scope: RasterPassScope;

  constructor(
    private readonly restrictedContext: RestrictedContext,
    renderPass: RHIRenderPassEncoder
  ) {
    this.scope = new RasterPassScope();
    const proxy = restrictedContext.createRenderPassProxy(renderPass) as UnderlyingRenderPass;
    this.raster = new RasterCommandsImpl(proxy, this.scope, (pipeline) =>
      restrictedContext.renderPipelineRequirements(pipeline)
    );
  }

  get device(): RestrictedPortableDevice {
    this.scope.assertActive();
    return this.restrictedContext.device;
  }

  texture(handle: TextureHandle, usage: TextureUsage, range?: TextureRange): RestrictedTextureView {
    this.scope.assertActive();
    return this.restrictedContext.texture(handle, usage, range);
  }

  buffer(handle: BufferHandle, usage: BufferUsage, range?: BufferRange): RestrictedBufferSlice {
    this.scope.assertActive();
    return this.restrictedContext.buffer(handle, usage, range);
  }

  renderPipeline(token: PreparedRenderPipelineToken): RestrictedRenderPipeline {
    this.scope.assertActive();
    return this.restrictedContext.renderPipeline(token);
  }

  computePipeline(token: PreparedComputePipelineToken): never {
    this.scope.assertActive();
    throw new Error('Compute pipelines cannot be resolved inside a raster pass context.');
  }

  bindGroupLayout(token: PreparedBindGroupLayoutToken): never {
    this.scope.assertActive();
    return this.restrictedContext.bindGroupLayout(token) as never;
  }

  drawResources(token: PreparedDrawResourcesToken): RestrictedPreparedDrawResources {
    this.scope.assertActive();
    return this.restrictedContext.drawResources(token);
  }

  revoke(): void {
    this.scope.revoke();
  }
}
