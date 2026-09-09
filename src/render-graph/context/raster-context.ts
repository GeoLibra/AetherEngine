import type { GPUColor } from '../../rhi/contracts';
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
  TextureRange,
  TextureUsage
} from '../types';
import type {
  PreparedBindGroupLayoutToken,
  PreparedComputePipelineToken,
  PreparedDrawResourcesToken,
  PreparedRenderPipelineToken
} from '../builder/prepared-resources';
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
  private readonly boundBindGroups = new Set<number>();
  private readonly boundVertexBuffers = new Set<number>();
  private hasIndexBuffer = false;

  constructor(
    private readonly pass: UnderlyingRenderPass,
    private readonly scope: RasterPassScope
  ) {}

  setPipeline = (pipeline: RestrictedRenderPipeline): void => {
    this.scope.assertActive();
    this.currentPipeline = pipeline;
    this.pass.setPipeline(pipeline);
  };

  setBindGroup = (
    index: number,
    bindGroup: RestrictedBindGroup,
    dynamicOffsets?: readonly number[]
  ): void => {
    this.scope.assertActive();
    this.boundBindGroups.add(index);
    this.pass.setBindGroup(index, bindGroup, dynamicOffsets);
  };

  setVertexBuffer = (
    slot: number,
    buffer: RestrictedBufferSlice,
    offset?: number,
    size?: number
  ): void => {
    this.scope.assertActive();
    this.boundVertexBuffers.add(slot);
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
        'DrawIndexed requires setIndexBuffer() to be called within the logical pass scope.'
      );
    }
    this.pass.drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
  };

  drawIndirect = (indirectBuffer: RestrictedBufferSlice, indirectOffset: number): void => {
    this.scope.assertActive();
    if (this.currentPipeline === undefined) {
      throw new Error(
        'DrawIndirect requires setPipeline() to be called within the logical pass scope.'
      );
    }
    this.pass.drawIndirect?.(indirectBuffer, indirectOffset);
  };
}

export class RasterPassContextImpl implements RasterPassContext {
  readonly raster: RasterCommands;
  private readonly scope: RasterPassScope;

  constructor(
    private readonly restrictedContext: RestrictedContext,
    renderPass: import('../../rhi/contracts').RHIRenderPassEncoder
  ) {
    this.scope = new RasterPassScope();
    const proxy = restrictedContext.createRenderPassProxy(renderPass) as UnderlyingRenderPass;
    this.raster = new RasterCommandsImpl(proxy, this.scope);
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
