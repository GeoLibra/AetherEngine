import { validateBindGroupSlot, validatePipelineLayout } from './bindings';
import { assertBufferUnmapped } from './buffer';
import { assertResourceLive, assertResourceOwnedBy, toResourceRef } from '../resource';
import type {
  GPUIndexFormat,
  GPUPrimitiveTopology,
  RHICommandRecord,
  RHIComputePassEncoder,
  RHIComputePipeline,
  RHIBindGroup,
  RHIBuffer,
  RHIPipelineLayout,
  RHIRenderPassDescriptor,
  RHIRenderPassEncoder,
  RHIRenderPipeline
} from '../types';
import type { NullDeviceOwner } from '../resource';
import { assertRHIFeature } from '../capability-validation';

export type NullPassEncoder = NullRenderPassEncoder | NullComputePassEncoder;

export interface NullPassController {
  readonly ownerToken: NullDeviceOwner;
  record(record: RHICommandRecord): void;
  recordDraw(vertexCount: number, instanceCount: number, topology: GPUPrimitiveTopology | undefined): void;
  recordIndexedDraw(indexCount: number, instanceCount: number, topology: GPUPrimitiveTopology | undefined): void;
  recordIndirectDraw(): void;
  recordDispatchWorkgroups(): void;
  recordDispatchWorkgroupsIndirect(): void;
  endPass(pass: NullPassEncoder): void;
}

export class NullRenderPassEncoder implements RHIRenderPassEncoder {
  private ended = false;
  private pipeline: RHIRenderPipeline | undefined;
  private debugGroupDepth = 0;
  private readonly extent: RenderPassExtent;
  private readonly bindGroups = new Map<number, { bindGroup: RHIBindGroup; dynamicOffsets: readonly number[] }>();
  private readonly vertexBuffers = new Map<number, RHIBuffer>();
  private indexBuffer: RHIBuffer | undefined;

  constructor(
    private readonly encoder: NullPassController,
    private readonly descriptor: RHIRenderPassDescriptor
  ) {
    this.extent = resolveRenderPassExtent(descriptor);
  }

  pushDebugGroup(groupLabel: string): void {
    this.ensureActive();
    this.debugGroupDepth += 1;
    this.encoder.record({ kind: 'pushDebugGroup', scope: 'render-pass', label: groupLabel });
  }

  popDebugGroup(): void {
    this.ensureActive();
    if (this.debugGroupDepth === 0) {
      throw new Error(`Render pass "${this.descriptor.label ?? 'anonymous'}" has no debug group to pop.`);
    }
    this.debugGroupDepth -= 1;
    this.encoder.record({ kind: 'popDebugGroup', scope: 'render-pass' });
  }

  setPipeline(pipeline: RHIRenderPipeline): void {
    this.ensureActive();
    assertResourceOwnedBy(pipeline, this.encoderOwner);
    assertResourceLive(pipeline);
    this.validateBoundGroups(pipeline.layout, false);
    this.pipeline = pipeline;
    this.encoder.record({ kind: 'setRenderPipeline', pipeline: toResourceRef(pipeline) });
  }

  setBindGroup(index: number, bindGroup: RHIBindGroup, dynamicOffsets: readonly number[] = []): void {
    this.ensureActive();
    validateBindGroupSlot(index, bindGroup, dynamicOffsets, this.encoderOwner, this.pipeline?.layout);
    this.bindGroups.set(index, { bindGroup, dynamicOffsets: [...dynamicOffsets] });
    this.encoder.record({
      kind: 'setBindGroup',
      scope: 'render-pass',
      index,
      bindGroup: toResourceRef(bindGroup),
      dynamicOffsets: [...dynamicOffsets]
    });
  }

  setVertexBuffer(slot: number, buffer: RHIBuffer, offset = 0, size?: number): void {
    this.ensureActive();
    assertResourceOwnedBy(buffer, this.encoderOwner);
    assertResourceLive(buffer);
    assertBufferUnmapped(buffer);
    this.vertexBuffers.set(slot, buffer);
    this.encoder.record(withOptionalSize({ kind: 'setVertexBuffer', slot, buffer: toResourceRef(buffer), offset }, size));
  }

  setIndexBuffer(buffer: RHIBuffer, indexFormat: GPUIndexFormat, offset = 0, size?: number): void {
    this.ensureActive();
    assertResourceOwnedBy(buffer, this.encoderOwner);
    assertResourceLive(buffer);
    assertBufferUnmapped(buffer);
    this.indexBuffer = buffer;
    this.encoder.record(
      withOptionalSize({ kind: 'setIndexBuffer', buffer: toResourceRef(buffer), indexFormat, offset }, size)
    );
  }

  setViewport(x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number): void {
    this.ensureActive();
    validateFiniteNumber(x, 'Viewport x');
    validateFiniteNumber(y, 'Viewport y');
    validateNonNegativeFiniteNumber(width, 'Viewport width');
    validateNonNegativeFiniteNumber(height, 'Viewport height');
    validateDepthRange(minDepth, 'Viewport minDepth');
    validateDepthRange(maxDepth, 'Viewport maxDepth');
    validateRectangleInExtent('Viewport', x, y, width, height, this.extent);
    this.encoder.record({ kind: 'setViewport', x, y, width, height, minDepth, maxDepth });
  }

  setScissorRect(x: number, y: number, width: number, height: number): void {
    this.ensureActive();
    validateNonNegativeInteger(x, 'Scissor x');
    validateNonNegativeInteger(y, 'Scissor y');
    validateNonNegativeInteger(width, 'Scissor width');
    validateNonNegativeInteger(height, 'Scissor height');
    validateRectangleInExtent('Scissor', x, y, width, height, this.extent);
    this.encoder.record({ kind: 'setScissorRect', x, y, width, height });
  }

  draw(vertexCount: number, instanceCount = 1, firstVertex = 0, firstInstance = 0): void {
    this.ensureActive();
    const pipeline = this.requirePipeline();
    this.validateBoundGroups(this.pipeline?.layout, true);
    this.validateBoundBuffers();
    this.encoder.record({ kind: 'draw', vertexCount, instanceCount, firstVertex, firstInstance });
    this.encoder.recordDraw(vertexCount, instanceCount, pipeline.topology);
  }

  drawIndexed(
    indexCount: number,
    instanceCount = 1,
    firstIndex = 0,
    baseVertex = 0,
    firstInstance = 0
  ): void {
    this.ensureActive();
    const pipeline = this.requirePipeline();
    this.validateBoundGroups(this.pipeline?.layout, true);
    this.validateBoundBuffers();
    if (this.indexBuffer === undefined) {
      throw new Error(`Render pass "${this.descriptor.label ?? 'anonymous'}" requires an index buffer before drawIndexed.`);
    }
    this.encoder.record({ kind: 'drawIndexed', indexCount, instanceCount, firstIndex, baseVertex, firstInstance });
    this.encoder.recordIndexedDraw(indexCount, instanceCount, pipeline.topology);
  }

  drawIndirect(indirectBuffer: RHIBuffer, indirectOffset: number): void {
    this.ensureActive();
    assertRHIFeature(this.encoder.ownerToken, 'indirect-draw', 'draw-indirect');
    this.requirePipeline();
    this.validateBoundGroups(this.pipeline?.layout, true);
    this.validateBoundBuffers();
    assertResourceOwnedBy(indirectBuffer, this.encoderOwner);
    assertResourceLive(indirectBuffer);
    assertBufferUnmapped(indirectBuffer);
    this.encoder.record({ kind: 'drawIndirect', buffer: toResourceRef(indirectBuffer), indirectOffset });
    this.encoder.recordIndirectDraw();
  }

  end(): void {
    if (this.ended) {
      throw new Error(`Render pass "${this.descriptor.label ?? 'anonymous'}" has already ended.`);
    }
    if (this.debugGroupDepth > 0) {
      throw new Error(`Render pass "${this.descriptor.label ?? 'anonymous'}" has unclosed debug groups.`);
    }
    this.ended = true;
    this.encoder.record(withOptionalLabel({ kind: 'endRenderPass' }, this.descriptor.label));
    this.encoder.endPass(this);
  }

  private ensureActive(): void {
    if (this.encoder.ownerToken.state !== 'live') {
      throw new Error(`Render pass "${this.descriptor.label ?? 'anonymous'}" belongs to a lost device.`);
    }
    if (this.ended) {
      throw new Error(`Render pass "${this.descriptor.label ?? 'anonymous'}" has already ended.`);
    }
  }

  private requirePipeline(): RHIRenderPipeline {
    if (this.pipeline === undefined) {
      throw new Error(`Render pass "${this.descriptor.label ?? 'anonymous'}" requires a render pipeline before drawing.`);
    }
    assertResourceLive(this.pipeline);
    validatePipelineLayout(this.pipeline.layout, this.encoderOwner);
    return this.pipeline;
  }

  private validateBoundGroups(pipelineLayout: RHIPipelineLayout | undefined, requireComplete: boolean): void {
    if (pipelineLayout !== undefined && requireComplete) {
      pipelineLayout.bindGroupLayouts.forEach((_, index) => {
        if (!this.bindGroups.has(index)) {
          throw new Error(`Bind group slot ${index} required by the current pipeline layout is not bound.`);
        }
      });
    }
    for (const [index, binding] of this.bindGroups) {
      validateBindGroupSlot(index, binding.bindGroup, binding.dynamicOffsets, this.encoderOwner, pipelineLayout);
    }
  }

  private validateBoundBuffers(): void {
    for (const buffer of this.vertexBuffers.values()) {
      assertResourceOwnedBy(buffer, this.encoderOwner);
      assertResourceLive(buffer);
      assertBufferUnmapped(buffer);
    }
    if (this.indexBuffer !== undefined) {
      assertResourceOwnedBy(this.indexBuffer, this.encoderOwner);
      assertResourceLive(this.indexBuffer);
      assertBufferUnmapped(this.indexBuffer);
    }
  }

  private get encoderOwner(): NullDeviceOwner {
    return this.encoder.ownerToken;
  }
}

export class NullComputePassEncoder implements RHIComputePassEncoder {
  private ended = false;
  private debugGroupDepth = 0;
  private pipeline: RHIComputePipeline | undefined;
  private readonly bindGroups = new Map<number, { bindGroup: RHIBindGroup; dynamicOffsets: readonly number[] }>();

  constructor(
    private readonly encoder: NullPassController,
    private readonly label: string | undefined
  ) {}

  pushDebugGroup(groupLabel: string): void {
    this.ensureActive();
    this.debugGroupDepth += 1;
    this.encoder.record({ kind: 'pushDebugGroup', scope: 'compute-pass', label: groupLabel });
  }

  popDebugGroup(): void {
    this.ensureActive();
    if (this.debugGroupDepth === 0) {
      throw new Error(`Compute pass "${this.label ?? 'anonymous'}" has no debug group to pop.`);
    }
    this.debugGroupDepth -= 1;
    this.encoder.record({ kind: 'popDebugGroup', scope: 'compute-pass' });
  }

  setPipeline(pipeline: RHIComputePipeline): void {
    this.ensureActive();
    assertResourceOwnedBy(pipeline, this.encoderOwner);
    assertResourceLive(pipeline);
    this.validateBoundGroups(pipeline.layout, false);
    this.pipeline = pipeline;
    this.encoder.record({ kind: 'setComputePipeline', pipeline: toResourceRef(pipeline) });
  }

  setBindGroup(index: number, bindGroup: RHIBindGroup, dynamicOffsets: readonly number[] = []): void {
    this.ensureActive();
    validateBindGroupSlot(index, bindGroup, dynamicOffsets, this.encoderOwner, this.pipeline?.layout);
    this.bindGroups.set(index, { bindGroup, dynamicOffsets: [...dynamicOffsets] });
    this.encoder.record({
      kind: 'setBindGroup',
      scope: 'compute-pass',
      index,
      bindGroup: toResourceRef(bindGroup),
      dynamicOffsets: [...dynamicOffsets]
    });
  }

  dispatchWorkgroups(x: number, y = 1, z = 1): void {
    this.ensureActive();
    this.requirePipeline();
    this.validateBoundGroups(this.pipeline?.layout, true);
    this.encoder.record({ kind: 'dispatchWorkgroups', x, y, z });
    this.encoder.recordDispatchWorkgroups();
  }

  dispatchWorkgroupsIndirect(indirectBuffer: RHIBuffer, indirectOffset: number): void {
    this.ensureActive();
    assertRHIFeature(this.encoder.ownerToken, 'indirect-draw', 'draw-indirect');
    this.requirePipeline();
    this.validateBoundGroups(this.pipeline?.layout, true);
    assertResourceOwnedBy(indirectBuffer, this.encoderOwner);
    assertResourceLive(indirectBuffer);
    assertBufferUnmapped(indirectBuffer);
    this.encoder.record({ kind: 'dispatchWorkgroupsIndirect', buffer: toResourceRef(indirectBuffer), indirectOffset });
    this.encoder.recordDispatchWorkgroupsIndirect();
  }

  end(): void {
    if (this.ended) {
      throw new Error(`Compute pass "${this.label ?? 'anonymous'}" has already ended.`);
    }
    if (this.debugGroupDepth > 0) {
      throw new Error(`Compute pass "${this.label ?? 'anonymous'}" has unclosed debug groups.`);
    }
    this.ended = true;
    this.encoder.record(withOptionalLabel({ kind: 'endComputePass' }, this.label));
    this.encoder.endPass(this);
  }

  private ensureActive(): void {
    if (this.encoder.ownerToken.state !== 'live') {
      throw new Error(`Compute pass "${this.label ?? 'anonymous'}" belongs to a lost device.`);
    }
    if (this.ended) {
      throw new Error(`Compute pass "${this.label ?? 'anonymous'}" has already ended.`);
    }
  }

  private requirePipeline(): RHIComputePipeline {
    if (this.pipeline === undefined) {
      throw new Error(`Compute pass "${this.label ?? 'anonymous'}" requires a compute pipeline before dispatch.`);
    }
    assertResourceLive(this.pipeline);
    validatePipelineLayout(this.pipeline.layout, this.encoderOwner);
    return this.pipeline;
  }

  private validateBoundGroups(pipelineLayout: RHIPipelineLayout | undefined, requireComplete: boolean): void {
    if (pipelineLayout !== undefined && requireComplete) {
      pipelineLayout.bindGroupLayouts.forEach((_, index) => {
        if (!this.bindGroups.has(index)) {
          throw new Error(`Bind group slot ${index} required by the current pipeline layout is not bound.`);
        }
      });
    }
    for (const [index, binding] of this.bindGroups) {
      validateBindGroupSlot(index, binding.bindGroup, binding.dynamicOffsets, this.encoderOwner, pipelineLayout);
    }
  }

  private get encoderOwner(): NullDeviceOwner {
    return this.encoder.ownerToken;
  }
}

function withOptionalLabel<T extends { kind: string }>(record: T, label: string | undefined): T & { label?: string } {
  if (label === undefined) {
    return record;
  }
  return { ...record, label };
}

function withOptionalSize<T extends { kind: string }>(record: T, size: number | undefined): T & { size?: number } {
  if (size === undefined) {
    return record;
  }
  return { ...record, size };
}

function validateFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
}

function validateNonNegativeFiniteNumber(value: number, label: string): void {
  validateFiniteNumber(value, label);
  if (value < 0) {
    throw new Error(`${label} must be non-negative.`);
  }
}

function validateDepthRange(value: number, label: string): void {
  validateFiniteNumber(value, label);
  if (value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1.`);
  }
}

function validateNonNegativeInteger(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${label} must be a finite integer.`);
  }
  if (value < 0) {
    throw new Error(`${label} must be non-negative.`);
  }
}

interface RenderPassExtent {
  width: number;
  height: number;
}

function resolveRenderPassExtent(descriptor: RHIRenderPassDescriptor): RenderPassExtent {
  const attachments = [
    ...descriptor.colorAttachments.map((attachment) => attachment.view),
    ...(descriptor.depthStencilAttachment === undefined ? [] : [descriptor.depthStencilAttachment.view])
  ];
  if (attachments.length === 0) {
    throw new Error(`Render pass "${descriptor.label ?? 'anonymous'}" requires at least one attachment.`);
  }

  const first = attachments[0];
  if (first === undefined) {
    throw new Error(`Render pass "${descriptor.label ?? 'anonymous'}" requires at least one attachment.`);
  }
  const extent = { width: first.width, height: first.height };
  attachments.slice(1).forEach((view, index) => {
    if (view.width !== extent.width || view.height !== extent.height) {
      throw new Error(
        `Render pass "${descriptor.label ?? 'anonymous'}" attachment at index ${index + 1} size ${view.width}x${view.height} does not match render pass extent ${extent.width}x${extent.height}.`
      );
    }
  });
  return extent;
}

function validateRectangleInExtent(
  label: 'Viewport' | 'Scissor',
  x: number,
  y: number,
  width: number,
  height: number,
  extent: RenderPassExtent
): void {
  // Loop 007: NullDevice uses strict containment to catch engine logic errors before backend-specific clipping.
  if (x < 0 || y < 0 || x + width > extent.width || y + height > extent.height) {
    throw new Error(
      `${label} rectangle ${x},${y} ${width}x${height} exceeds render pass extent ${extent.width}x${extent.height}.`
    );
  }
}
