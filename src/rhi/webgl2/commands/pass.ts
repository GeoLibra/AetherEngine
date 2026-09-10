import type {
  GPUIndexFormat,
  GPUPrimitiveTopology,
  RHIBindGroup,
  RHIBuffer,
  RHICommandRecord,
  RHIPipelineLayout,
  RHIResource,
  RHIRenderPassDescriptor,
  RHIRenderPassEncoder,
  RHIRenderPipeline
} from '../../contracts';
import { toResourceRef } from '../../core/resource-ref';
import { getWebGL2BindGroupResources, validateWebGL2BindGroupSlot } from '../pipeline/bindings';
import { assertWebGL2Resource } from '../resources/resource';
import type { WebGL2DeviceOwner } from '../types';
import type { WebGL2ReplayCommand } from '../types';
import { throwWebGL2Unsupported } from '../unsupported';

export interface WebGL2PassController {
  readonly ownerToken: WebGL2DeviceOwner;
  record(replay: WebGL2ReplayCommand, portable: RHICommandRecord): void;
  lease(resource: RHIResource): void;
  recordDraw(
    vertexCount: number,
    instanceCount: number,
    topology: GPUPrimitiveTopology | undefined
  ): void;
  recordIndexedDraw(
    indexCount: number,
    instanceCount: number,
    topology: GPUPrimitiveTopology | undefined
  ): void;
  endPass(pass: WebGL2RenderPassEncoder): void;
}

export class WebGL2RenderPassEncoder implements RHIRenderPassEncoder {
  private ended = false;
  private debugGroupDepth = 0;
  private pipeline: RHIRenderPipeline | undefined;
  private readonly extent: Readonly<{ width: number; height: number }>;
  private readonly bindGroups = new Map<
    number,
    { group: RHIBindGroup; offsets: readonly number[] }
  >();
  private readonly vertexBuffers = new Map<number, RHIBuffer>();
  private indexBuffer: RHIBuffer | undefined;

  constructor(
    private readonly encoder: WebGL2PassController,
    private readonly descriptor: RHIRenderPassDescriptor
  ) {
    this.extent = resolveRenderPassExtent(descriptor);
  }

  pushDebugGroup(label: string): void {
    this.ensureActive();
    this.debugGroupDepth += 1;
    this.encoder.record(
      { kind: 'push-debug', scope: 'render-pass', label },
      { kind: 'pushDebugGroup', scope: 'render-pass', label }
    );
  }

  popDebugGroup(): void {
    this.ensureActive();
    if (this.debugGroupDepth === 0) throw new Error(`${this.passName} has no debug group to pop.`);
    this.debugGroupDepth -= 1;
    this.encoder.record(
      { kind: 'pop-debug', scope: 'render-pass' },
      { kind: 'popDebugGroup', scope: 'render-pass' }
    );
  }

  setPipeline(pipeline: RHIRenderPipeline): void {
    this.ensureActive();
    assertWebGL2Resource(pipeline, this.owner);
    this.pipeline = pipeline;
    this.encoder.lease(pipeline);
    this.encoder.record(
      { kind: 'set-pipeline', pipeline },
      { kind: 'setRenderPipeline', pipeline: toResourceRef(pipeline) }
    );
  }

  setBindGroup(index: number, group: RHIBindGroup, dynamicOffsets: readonly number[] = []): void {
    this.ensureActive();
    // Validate basic bind group slot without pipeline layout (defer layout compatibility to draw)
    validateWebGL2BindGroupSlot(index, group, dynamicOffsets, this.owner, undefined);
    const offsets = [...dynamicOffsets];
    this.bindGroups.set(index, { group, offsets });
    this.encoder.lease(group);
    for (const resource of getWebGL2BindGroupResources(group)) this.encoder.lease(resource);
    this.encoder.record(
      { kind: 'set-bind-group', index, group, dynamicOffsets: offsets },
      {
        kind: 'setBindGroup',
        scope: 'render-pass',
        index,
        bindGroup: toResourceRef(group),
        dynamicOffsets: offsets
      }
    );
  }

  setVertexBuffer(slot: number, buffer: RHIBuffer, offset = 0, size?: number): void {
    this.ensureActive();
    validateBufferBinding(buffer, offset, size, this.owner, `Vertex buffer slot ${slot}`);
    this.vertexBuffers.set(slot, buffer);
    this.encoder.lease(buffer);
    this.encoder.record(
      { kind: 'set-vertex-buffer', slot, buffer, offset, ...(size === undefined ? {} : { size }) },
      {
        kind: 'setVertexBuffer',
        slot,
        buffer: toResourceRef(buffer),
        offset,
        ...(size === undefined ? {} : { size })
      }
    );
  }

  setIndexBuffer(buffer: RHIBuffer, indexFormat: GPUIndexFormat, offset = 0, size?: number): void {
    this.ensureActive();
    validateBufferBinding(buffer, offset, size, this.owner, 'Index buffer');
    this.indexBuffer = buffer;
    this.encoder.lease(buffer);
    this.encoder.record(
      {
        kind: 'set-index-buffer',
        buffer,
        indexFormat,
        offset,
        ...(size === undefined ? {} : { size })
      },
      {
        kind: 'setIndexBuffer',
        buffer: toResourceRef(buffer),
        indexFormat,
        offset,
        ...(size === undefined ? {} : { size })
      }
    );
  }

  setViewport(
    x: number,
    y: number,
    width: number,
    height: number,
    minDepth: number,
    maxDepth: number
  ): void {
    this.ensureActive();
    validateRectangle('Viewport', x, y, width, height, this.extent, false);
    validateDepth(minDepth, 'Viewport minDepth');
    validateDepth(maxDepth, 'Viewport maxDepth');
    this.encoder.record(
      { kind: 'set-viewport', x, y, width, height, minDepth, maxDepth },
      { kind: 'setViewport', x, y, width, height, minDepth, maxDepth }
    );
  }

  setScissorRect(x: number, y: number, width: number, height: number): void {
    this.ensureActive();
    validateRectangle('Scissor', x, y, width, height, this.extent, true);
    this.encoder.record(
      { kind: 'set-scissor', x, y, width, height },
      { kind: 'setScissorRect', x, y, width, height }
    );
  }

  draw(vertexCount: number, instanceCount = 1, firstVertex = 0, firstInstance = 0): void {
    this.ensureActive();
    const pipeline = this.requireReadyToDraw();
    validateDrawArguments([vertexCount, instanceCount, firstVertex, firstInstance]);
    this.encoder.record(
      { kind: 'draw', vertexCount, instanceCount, firstVertex, firstInstance },
      { kind: 'draw', vertexCount, instanceCount, firstVertex, firstInstance }
    );
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
    const pipeline = this.requireReadyToDraw();
    validateDrawArguments([indexCount, instanceCount, firstIndex, firstInstance]);
    if (!Number.isInteger(baseVertex)) throw new Error('Draw baseVertex must be an integer.');
    if (this.indexBuffer === undefined)
      throw new Error(`${this.passName} requires an index buffer before drawIndexed.`);
    this.encoder.record(
      { kind: 'draw-indexed', indexCount, instanceCount, firstIndex, baseVertex, firstInstance },
      { kind: 'drawIndexed', indexCount, instanceCount, firstIndex, baseVertex, firstInstance }
    );
    this.encoder.recordIndexedDraw(indexCount, instanceCount, pipeline.topology);
  }

  drawIndirect(_buffer: RHIBuffer, _offset: number): void {
    this.ensureActive();
    return throwWebGL2Unsupported(this.owner.capabilities, 'indirect-draw', 'draw-indirect');
  }

  end(): void {
    if (this.ended) throw new Error(`${this.passName} has already ended.`);
    if (this.debugGroupDepth > 0) throw new Error(`${this.passName} has unclosed debug groups.`);
    this.ended = true;
    const label = this.descriptor.label;
    this.encoder.record(
      { kind: 'end-render-pass', ...(label === undefined ? {} : { label }) },
      { kind: 'endRenderPass', ...(label === undefined ? {} : { label }) }
    );
    this.encoder.endPass(this);
  }

  private requireReadyToDraw(): RHIRenderPipeline {
    if (this.pipeline === undefined)
      throw new Error(`${this.passName} requires a render pipeline before drawing.`);
    assertWebGL2Resource(this.pipeline, this.owner);
    this.validateBoundGroups(this.pipeline.layout);
    for (const buffer of this.vertexBuffers.values()) assertWebGL2Resource(buffer, this.owner);
    if (this.indexBuffer !== undefined) assertWebGL2Resource(this.indexBuffer, this.owner);
    return this.pipeline;
  }

  private validateBoundGroups(layout: RHIPipelineLayout | undefined): void {
    if (layout === undefined) return;
    // Only validate bind group slots that the pipeline layout actually requires
    // This allows multiple logical passes to share one physical pass with different pipelines
    layout.bindGroupLayouts.forEach((expected, index) => {
      const bound = this.bindGroups.get(index);
      if (bound === undefined) {
        throw new Error(
          `Bind group slot ${index} required by the current pipeline layout is not bound.`
        );
      }
      if (bound.group.layout !== expected) {
        throw new Error(
          `Bind group slot ${index} is incompatible with the current pipeline layout.`
        );
      }
    });
  }

  private ensureActive(): void {
    if (this.owner.state !== 'live') throw new Error(`${this.passName} belongs to a lost device.`);
    if (this.ended) throw new Error(`${this.passName} has already ended.`);
  }

  private get owner(): WebGL2DeviceOwner {
    return this.encoder.ownerToken;
  }
  private get passName(): string {
    return `Render pass "${this.descriptor.label ?? 'anonymous'}"`;
  }
}

function validateBufferBinding(
  buffer: RHIBuffer,
  offset: number,
  size: number | undefined,
  owner: WebGL2DeviceOwner,
  label: string
): void {
  assertWebGL2Resource(buffer, owner);
  const rangeSize = size ?? buffer.size - offset;
  if (
    !Number.isInteger(offset) ||
    !Number.isInteger(rangeSize) ||
    offset < 0 ||
    rangeSize < 0 ||
    offset + rangeSize > buffer.size
  ) {
    throw new Error(
      `${label} range ${offset}..${offset + rangeSize} is outside buffer size ${buffer.size}.`
    );
  }
}

function resolveRenderPassExtent(
  descriptor: RHIRenderPassDescriptor
): Readonly<{ width: number; height: number }> {
  const views = descriptor.colorAttachments.map((attachment) => attachment.view);
  if (descriptor.depthStencilAttachment !== undefined)
    views.push(descriptor.depthStencilAttachment.view);
  const first = views[0];
  if (first === undefined)
    throw new Error(
      `Render pass "${descriptor.label ?? 'anonymous'}" requires at least one attachment.`
    );
  for (const view of views.slice(1)) {
    if (view.width !== first.width || view.height !== first.height)
      throw new Error('Render pass attachments must have matching extents.');
  }
  return { width: first.width, height: first.height };
}

function validateRectangle(
  label: string,
  x: number,
  y: number,
  width: number,
  height: number,
  extent: { width: number; height: number },
  integer: boolean
): void {
  const values = [x, y, width, height];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    (integer && values.some((value) => !Number.isInteger(value)))
  ) {
    throw new Error(`${label} rectangle must use ${integer ? 'integer ' : ''}finite values.`);
  }
  if (
    x < 0 ||
    y < 0 ||
    width < 0 ||
    height < 0 ||
    x + width > extent.width ||
    y + height > extent.height
  ) {
    throw new Error(
      `${label} rectangle ${x},${y} ${width}x${height} exceeds render pass extent ${extent.width}x${extent.height}.`
    );
  }
}

function validateDepth(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new Error(`${label} must be between 0 and 1.`);
}

function validateDrawArguments(values: readonly number[]): void {
  if (values.some((value) => !Number.isInteger(value) || value < 0))
    throw new Error('Draw arguments must be non-negative integers.');
}
