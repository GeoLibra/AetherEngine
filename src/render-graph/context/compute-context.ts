import type { RHIComputePassEncoder } from '../../rhi/contracts';
import type { RestrictedContext } from './restricted-context';
import type {
  BufferHandle,
  BufferRange,
  BufferUsage,
  ComputeCommands,
  ComputePassContext,
  PreparedBindGroupLayoutToken,
  PreparedComputePipelineToken,
  PreparedDrawResourcesToken,
  PreparedRenderPipelineToken,
  RestrictedBindGroup,
  RestrictedBindGroupLayout,
  RestrictedBufferSlice,
  RestrictedComputePipeline,
  RestrictedPortableDevice,
  RestrictedTextureView,
  TextureHandle,
  TextureRange,
  TextureUsage
} from '../types';

export class ComputePassScope {
  private active = true;
  readonly scopeId = Symbol('ComputePassScope');

  revoke(): void {
    this.active = false;
  }

  assertActive(): void {
    if (!this.active) {
      throw new Error('Cannot invoke compute commands outside of the active pass callback scope.');
    }
  }
}

export interface UnderlyingComputePass {
  setPipeline(pipeline: RestrictedComputePipeline): void;
  setBindGroup(
    index: number,
    bindGroup: RestrictedBindGroup,
    dynamicOffsets?: readonly number[]
  ): void;
  dispatchWorkgroups(
    workgroupCountX: number,
    workgroupCountY?: number,
    workgroupCountZ?: number
  ): void;
  dispatchWorkgroupsIndirect?(indirectBuffer: RestrictedBufferSlice, indirectOffset: number): void;
}

export class ComputeCommandsImpl implements ComputeCommands {
  private currentPipeline?: RestrictedComputePipeline | undefined;

  constructor(
    private readonly pass: UnderlyingComputePass,
    private readonly scope: ComputePassScope
  ) {}

  setPipeline = (pipeline: RestrictedComputePipeline): void => {
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
    this.pass.setBindGroup(index, bindGroup, dynamicOffsets);
  };

  dispatchWorkgroups = (
    workgroupCountX: number,
    workgroupCountY = 1,
    workgroupCountZ = 1
  ): void => {
    this.scope.assertActive();
    if (this.currentPipeline === undefined) {
      throw new Error(
        'Dispatch requires setPipeline() to be called within the pass callback scope.'
      );
    }
    this.pass.dispatchWorkgroups(workgroupCountX, workgroupCountY, workgroupCountZ);
  };

  dispatchWorkgroupsIndirect = (
    indirectBuffer: RestrictedBufferSlice,
    indirectOffset: number
  ): void => {
    this.scope.assertActive();
    if (this.currentPipeline === undefined) {
      throw new Error(
        'Indirect dispatch requires setPipeline() to be called within the pass callback scope.'
      );
    }
    this.pass.dispatchWorkgroupsIndirect?.(indirectBuffer, indirectOffset);
  };
}

export class ComputePassContextImpl implements ComputePassContext {
  readonly compute: ComputeCommands;
  private readonly scope: ComputePassScope;

  constructor(
    private readonly restrictedContext: RestrictedContext,
    computePass: RHIComputePassEncoder
  ) {
    this.scope = new ComputePassScope();
    this.compute = new ComputeCommandsImpl(
      restrictedContext.createComputePassProxy(computePass) as UnderlyingComputePass,
      this.scope
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

  renderPipeline(token: PreparedRenderPipelineToken): never {
    this.scope.assertActive();
    throw new Error('Render pipelines cannot be resolved inside a compute pass context.');
  }

  computePipeline(token: PreparedComputePipelineToken): RestrictedComputePipeline {
    this.scope.assertActive();
    return this.restrictedContext.computePipeline(token);
  }

  bindGroupLayout(token: PreparedBindGroupLayoutToken): RestrictedBindGroupLayout {
    this.scope.assertActive();
    return this.restrictedContext.bindGroupLayout(token);
  }

  drawResources(token: PreparedDrawResourcesToken): never {
    this.scope.assertActive();
    throw new Error('Draw resources cannot be resolved inside a compute pass context.');
  }

  revoke(): void {
    this.scope.revoke();
  }
}
