import type { RHIComputePassEncoder, RHIRenderPassEncoder } from '../contracts/command';
import type {
  RHIBindGroup,
  RHIBuffer,
  RHIComputePipeline,
  RHIRenderPipeline,
  RHIResource,
} from '../contracts/resource';
import type { GPUIndexFormat } from '../contracts/webgpu';
import type {
  WebGPUNativeComputePassPort,
  WebGPUNativeRenderPassPort,
  WebGPUNativeResourcePort,
} from './native-types';

export interface WebGPUCommandPassController {
  lease(resource: RHIResource): void;
  nativeHandle(resource: RHIResource): WebGPUNativeResourcePort;
  assertPassActive(): void;
  endPass(): void;
  draw(
    vertices: number,
    instances: number,
    topology: RHIRenderPipeline['topology']
  ): void;
  drawIndexed(
    indices: number,
    instances: number,
    topology: RHIRenderPipeline['topology']
  ): void;
  drawIndirect(): void;
  dispatch(indirect: boolean): void;
}

export class WebGPURenderPass implements RHIRenderPassEncoder {
  private ended = false;
  private debugDepth = 0;
  private pipeline: RHIRenderPipeline | undefined;

  constructor(
    private readonly encoder: WebGPUCommandPassController,
    private readonly native: WebGPUNativeRenderPassPort
  ) {}

  pushDebugGroup(label: string): void {
    this.active();
    this.debugDepth += 1;
    this.native.pushDebugGroup(label);
  }

  popDebugGroup(): void {
    this.active();
    if (this.debugDepth === 0)
      throw new Error('WebGPU render pass has no debug group to pop.');
    this.debugDepth -= 1;
    this.native.popDebugGroup();
  }

  setPipeline(pipeline: RHIRenderPipeline): void {
    this.active();
    this.pipeline = pipeline;
    this.native.setPipeline(this.handle(pipeline));
  }

  setBindGroup(
    index: number,
    group: RHIBindGroup,
    offsets: readonly number[] = []
  ): void {
    this.active();
    for (const entry of group.descriptor.entries)
      this.encoder.lease(
        'buffer' in entry.resource ? entry.resource.buffer : entry.resource
      );
    this.native.setBindGroup(index, this.handle(group), offsets);
  }

  setVertexBuffer(
    slot: number,
    buffer: RHIBuffer,
    offset = 0,
    size?: number
  ): void {
    this.active();
    this.native.setVertexBuffer(slot, this.handle(buffer), offset, size);
  }

  setIndexBuffer(
    buffer: RHIBuffer,
    format: GPUIndexFormat,
    offset = 0,
    size?: number
  ): void {
    this.active();
    this.native.setIndexBuffer(this.handle(buffer), format, offset, size);
  }

  setViewport(
    x: number,
    y: number,
    width: number,
    height: number,
    minDepth: number,
    maxDepth: number
  ): void {
    this.active();
    this.native.setViewport(x, y, width, height, minDepth, maxDepth);
  }

  setScissorRect(x: number, y: number, width: number, height: number): void {
    this.active();
    this.native.setScissorRect(x, y, width, height);
  }

  draw(
    vertexCount: number,
    instanceCount = 1,
    firstVertex = 0,
    firstInstance = 0
  ): void {
    this.active();
    const pipeline = this.requirePipeline();
    this.native.draw(vertexCount, instanceCount, firstVertex, firstInstance);
    this.encoder.draw(vertexCount, instanceCount, pipeline.topology);
  }

  drawIndexed(
    indexCount: number,
    instanceCount = 1,
    firstIndex = 0,
    baseVertex = 0,
    firstInstance = 0
  ): void {
    this.active();
    const pipeline = this.requirePipeline();
    this.native.drawIndexed(
      indexCount,
      instanceCount,
      firstIndex,
      baseVertex,
      firstInstance
    );
    this.encoder.drawIndexed(indexCount, instanceCount, pipeline.topology);
  }

  drawIndirect(buffer: RHIBuffer, offset: number): void {
    this.active();
    this.requirePipeline();
    this.native.drawIndirect(this.handle(buffer), offset);
    this.encoder.drawIndirect();
  }

  end(): void {
    this.active();
    if (this.debugDepth > 0)
      throw new Error('WebGPU render pass has unclosed debug groups.');
    this.ended = true;
    this.native.end();
    this.encoder.endPass();
  }

  private active(): void {
    if (this.ended) throw new Error('WebGPU render pass has already ended.');
    this.encoder.assertPassActive();
  }

  private requirePipeline(): RHIRenderPipeline {
    if (this.pipeline === undefined)
      throw new Error('WebGPU render pass requires a pipeline before drawing.');
    return this.pipeline;
  }

  private handle(resource: RHIResource): WebGPUNativeResourcePort {
    return this.encoder.nativeHandle(resource);
  }
}

export class WebGPUComputePass implements RHIComputePassEncoder {
  private ended = false;
  private debugDepth = 0;
  private pipeline: RHIComputePipeline | undefined;

  constructor(
    private readonly encoder: WebGPUCommandPassController,
    private readonly native: WebGPUNativeComputePassPort
  ) {}

  pushDebugGroup(label: string): void {
    this.active();
    this.debugDepth += 1;
    this.native.pushDebugGroup(label);
  }

  popDebugGroup(): void {
    this.active();
    if (this.debugDepth === 0)
      throw new Error('WebGPU compute pass has no debug group to pop.');
    this.debugDepth -= 1;
    this.native.popDebugGroup();
  }

  setPipeline(pipeline: RHIComputePipeline): void {
    this.active();
    this.pipeline = pipeline;
    this.native.setPipeline(this.handle(pipeline));
  }

  setBindGroup(
    index: number,
    group: RHIBindGroup,
    offsets: readonly number[] = []
  ): void {
    this.active();
    for (const entry of group.descriptor.entries)
      this.encoder.lease(
        'buffer' in entry.resource ? entry.resource.buffer : entry.resource
      );
    this.native.setBindGroup(index, this.handle(group), offsets);
  }

  dispatchWorkgroups(x: number, y = 1, z = 1): void {
    this.active();
    this.requirePipeline();
    this.native.dispatchWorkgroups(x, y, z);
    this.encoder.dispatch(false);
  }

  dispatchWorkgroupsIndirect(buffer: RHIBuffer, offset: number): void {
    this.active();
    this.requirePipeline();
    this.native.dispatchWorkgroupsIndirect(this.handle(buffer), offset);
    this.encoder.dispatch(true);
  }

  end(): void {
    this.active();
    if (this.debugDepth > 0)
      throw new Error('WebGPU compute pass has unclosed debug groups.');
    this.ended = true;
    this.native.end();
    this.encoder.endPass();
  }

  private active(): void {
    if (this.ended) throw new Error('WebGPU compute pass has already ended.');
    this.encoder.assertPassActive();
  }

  private requirePipeline(): void {
    if (this.pipeline === undefined)
      throw new Error(
        'WebGPU compute pass requires a pipeline before dispatch.'
      );
  }

  private handle(resource: RHIResource): WebGPUNativeResourcePort {
    return this.encoder.nativeHandle(resource);
  }
}
