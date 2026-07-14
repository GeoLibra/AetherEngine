import type {
  RHICommandBuffer,
  RHICommandEncoder,
  RHICommandRecord,
  RHICommandStats,
  RHIComputePassEncoder,
  RHIRenderPassEncoder
} from '../command-types';
import type { RHIResource, RHIRenderPipeline, RHIComputePipeline, RHIBindGroup, RHIBuffer, GPUImageCopyTexture } from '../resource-types';
import type { RHIRenderPassDescriptor } from '../render-target-types';
import type { GPUCommandBufferDescriptor, GPUCommandEncoderDescriptor, GPUComputePassDescriptor, GPUExtent3D, GPUIndexFormat } from '../webgpu-types';
import { cloneCommandStats, createCommandStats, recordDraw, recordIndexedDraw, recordIndirectDraw } from '../stats';
import type { WebGPUNativeCommandEncoderPort, WebGPUNativeComputePassPort, WebGPUNativeRenderPassPort, WebGPUNativeResourcePort } from './native-types';
import { WebGPUResourceBase, getWebGPUNativeHandle, normalizeExtent, type WebGPUDeviceOwner } from './resource';

interface EncoderInteropState {
  readonly owner: WebGPUDeviceOwner;
  readonly native: WebGPUNativeCommandEncoderPort;
  readonly assertAvailable: () => void;
}

const encoderInteropState = new WeakMap<WebGPUCommandEncoder, EncoderInteropState>();

export class WebGPUCommandBuffer extends WebGPUResourceBase implements RHICommandBuffer {
  readonly kind = 'command-buffer';
  private submitted = false;
  constructor(
    id: number,
    owner: WebGPUDeviceOwner,
    native: WebGPUNativeResourcePort,
    label: string | undefined,
    private readonly stats: RHICommandStats,
    private readonly leases: readonly RHIResource[]
  ) { super(id, owner, native, label); }
  getStats(): RHICommandStats { return cloneCommandStats(this.stats); }
  getCommandStream(): readonly RHICommandRecord[] { return Object.freeze([]); }
  toCommandStreamJSON(): string { return '[]'; }
  getLeases(): readonly RHIResource[] { return this.leases; }
  assertReadyForSubmit(): void {
    if (this.submitted) throw new Error(`Command buffer "${this.label ?? 'command-buffer'}" has already been submitted.`);
  }
  markSubmitted(): void { this.assertReadyForSubmit(); this.submitted = true; }
}

export class WebGPUCommandEncoder implements RHICommandEncoder {
  private readonly stats = createCommandStats();
  private readonly leases = new Set<RHIResource>();
  private activePass = false;
  private finished = false;
  private debugDepth = 0;
  constructor(
    private readonly id: number,
    private readonly owner: WebGPUDeviceOwner,
    private readonly native: WebGPUNativeCommandEncoderPort,
    private readonly label: string | undefined
  ) {
    encoderInteropState.set(this, {
      owner,
      native,
      assertAvailable: () => this.ensureIdle()
    });
  }

  beginRenderPass(descriptor: RHIRenderPassDescriptor): RHIRenderPassEncoder {
    this.beginPass();
    const colorAttachments = descriptor.colorAttachments.map((attachment) => {
      this.lease(attachment.view);
      if (attachment.resolveTarget !== undefined) this.lease(attachment.resolveTarget);
      return Object.freeze({
        ...attachment,
        view: getWebGPUNativeHandle(attachment.view, this.owner),
        ...(attachment.resolveTarget === undefined ? {} : { resolveTarget: getWebGPUNativeHandle(attachment.resolveTarget, this.owner) })
      });
    });
    const lowered: Record<string, unknown> = { colorAttachments: Object.freeze(colorAttachments) };
    if (descriptor.label !== undefined) lowered.label = descriptor.label;
    if (descriptor.depthStencilAttachment !== undefined) {
      this.lease(descriptor.depthStencilAttachment.view);
      lowered.depthStencilAttachment = Object.freeze({
        ...descriptor.depthStencilAttachment,
        view: getWebGPUNativeHandle(descriptor.depthStencilAttachment.view, this.owner)
      });
    }
    this.stats.renderPasses += 1;
    return new WebGPURenderPass(this, this.native.beginRenderPass(Object.freeze(lowered)));
  }

  beginComputePass(descriptor: GPUComputePassDescriptor = {}): RHIComputePassEncoder {
    this.beginPass();
    this.stats.computePasses += 1;
    return new WebGPUComputePass(this, this.native.beginComputePass(Object.freeze({ ...descriptor })));
  }
  pushDebugGroup(label: string): void { this.ensureOpen(); this.debugDepth += 1; this.native.pushDebugGroup(label); }
  popDebugGroup(): void {
    this.ensureOpen();
    if (this.debugDepth === 0) throw new Error('WebGPU command encoder has no debug group to pop.');
    this.debugDepth -= 1;
    this.native.popDebugGroup();
  }
  copyBufferToBuffer(source: RHIBuffer, sourceOffset: number, destination: RHIBuffer, destinationOffset: number, size: number): void {
    this.ensureIdle(); this.lease(source); this.lease(destination);
    this.native.copyBufferToBuffer(
      getWebGPUNativeHandle(source, this.owner), sourceOffset,
      getWebGPUNativeHandle(destination, this.owner), destinationOffset, size
    );
    this.stats.copy.copyBufferToBuffer += 1;
  }
  copyTextureToTexture(source: GPUImageCopyTexture, destination: GPUImageCopyTexture, copySize: GPUExtent3D): void {
    this.ensureIdle(); this.lease(source.texture); this.lease(destination.texture);
    this.native.copyTextureToTexture(
      Object.freeze({ ...source, texture: getWebGPUNativeHandle(source.texture, this.owner) }),
      Object.freeze({ ...destination, texture: getWebGPUNativeHandle(destination.texture, this.owner) }),
      normalizeExtent(copySize)
    );
    this.stats.copy.copyTextureToTexture += 1;
  }
  finish(descriptor: GPUCommandBufferDescriptor = {}): RHICommandBuffer {
    this.ensureIdle();
    if (this.debugDepth > 0) throw new Error('WebGPU command encoder has unclosed debug groups.');
    this.finished = true;
    return new WebGPUCommandBuffer(
      this.id, this.owner, this.native.finish(Object.freeze({ ...descriptor })), descriptor.label,
      cloneCommandStats(this.stats), Object.freeze([...this.leases])
    );
  }
  getStats(): RHICommandStats { return cloneCommandStats(this.stats); }
  lease(resource: RHIResource): void { getWebGPUNativeHandle(resource, this.owner); this.leases.add(resource); }
  nativeHandle(resource: RHIResource): WebGPUNativeResourcePort { this.lease(resource); return getWebGPUNativeHandle(resource, this.owner); }
  assertPassActive(): void { this.ensureOpen(); }
  endPass(): void { this.activePass = false; }
  draw(vertices: number, instances: number, topology: RHIRenderPipeline['topology']): void { recordDraw(this.stats, vertices, instances, topology); }
  drawIndexed(indices: number, instances: number, topology: RHIRenderPipeline['topology']): void { recordIndexedDraw(this.stats, indices, instances, topology); }
  drawIndirect(): void { recordIndirectDraw(this.stats); }
  dispatch(indirect: boolean): void {
    if (indirect) this.stats.compute.dispatchWorkgroupsIndirect += 1;
    else this.stats.compute.dispatchWorkgroups += 1;
  }
  private beginPass(): void { this.ensureIdle(); this.activePass = true; }
  private ensureOpen(): void {
    if (this.finished) throw new Error('WebGPU command encoder has already finished.');
    if (this.owner.state !== 'live') throw new Error('WebGPU command encoder belongs to a lost device.');
  }
  private ensureIdle(): void { this.ensureOpen(); if (this.activePass) throw new Error('WebGPU command encoder has an active pass.'); }
}

export function getWebGPUNativeCommandEncoder(
  encoder: RHICommandEncoder,
  owner: WebGPUDeviceOwner
): WebGPUNativeCommandEncoderPort {
  if (!(encoder instanceof WebGPUCommandEncoder)) {
    throw new Error('Command encoder was not created by WebGPUDevice.');
  }
  const state = encoderInteropState.get(encoder);
  if (state === undefined) throw new Error('WebGPU command encoder has no native handle.');
  if (state.owner !== owner) throw new Error('Command encoder belongs to a different WebGPUDevice.');
  state.assertAvailable();
  return state.native;
}

class WebGPURenderPass implements RHIRenderPassEncoder {
  private ended = false;
  private debugDepth = 0;
  private pipeline: RHIRenderPipeline | undefined;
  constructor(private readonly encoder: WebGPUCommandEncoder, private readonly native: WebGPUNativeRenderPassPort) {}
  pushDebugGroup(label: string): void { this.active(); this.debugDepth += 1; this.native.pushDebugGroup(label); }
  popDebugGroup(): void { this.active(); if (this.debugDepth === 0) throw new Error('WebGPU render pass has no debug group to pop.'); this.debugDepth -= 1; this.native.popDebugGroup(); }
  setPipeline(pipeline: RHIRenderPipeline): void { this.active(); this.pipeline = pipeline; this.native.setPipeline(this.handle(pipeline)); }
  setBindGroup(index: number, group: RHIBindGroup, offsets: readonly number[] = []): void {
    this.active(); for (const entry of group.descriptor.entries) this.encoder.lease('buffer' in entry.resource ? entry.resource.buffer : entry.resource);
    this.native.setBindGroup(index, this.handle(group), offsets);
  }
  setVertexBuffer(slot: number, buffer: RHIBuffer, offset = 0, size?: number): void { this.active(); this.native.setVertexBuffer(slot, this.handle(buffer), offset, size); }
  setIndexBuffer(buffer: RHIBuffer, format: GPUIndexFormat, offset = 0, size?: number): void { this.active(); this.native.setIndexBuffer(this.handle(buffer), format, offset, size); }
  setViewport(x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number): void { this.active(); this.native.setViewport(x, y, width, height, minDepth, maxDepth); }
  setScissorRect(x: number, y: number, width: number, height: number): void { this.active(); this.native.setScissorRect(x, y, width, height); }
  draw(vertexCount: number, instanceCount = 1, firstVertex = 0, firstInstance = 0): void { this.active(); const pipeline = this.requirePipeline(); this.native.draw(vertexCount, instanceCount, firstVertex, firstInstance); this.encoder.draw(vertexCount, instanceCount, pipeline.topology); }
  drawIndexed(indexCount: number, instanceCount = 1, firstIndex = 0, baseVertex = 0, firstInstance = 0): void { this.active(); const pipeline = this.requirePipeline(); this.native.drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance); this.encoder.drawIndexed(indexCount, instanceCount, pipeline.topology); }
  drawIndirect(buffer: RHIBuffer, offset: number): void { this.active(); this.requirePipeline(); this.native.drawIndirect(this.handle(buffer), offset); this.encoder.drawIndirect(); }
  end(): void { this.active(); if (this.debugDepth > 0) throw new Error('WebGPU render pass has unclosed debug groups.'); this.ended = true; this.native.end(); this.encoder.endPass(); }
  private active(): void { if (this.ended) throw new Error('WebGPU render pass has already ended.'); this.encoder.assertPassActive(); }
  private requirePipeline(): RHIRenderPipeline { if (this.pipeline === undefined) throw new Error('WebGPU render pass requires a pipeline before drawing.'); return this.pipeline; }
  private handle(resource: RHIResource) { return this.encoder.nativeHandle(resource); }
}

class WebGPUComputePass implements RHIComputePassEncoder {
  private ended = false;
  private debugDepth = 0;
  private pipeline: RHIComputePipeline | undefined;
  constructor(private readonly encoder: WebGPUCommandEncoder, private readonly native: WebGPUNativeComputePassPort) {}
  pushDebugGroup(label: string): void { this.active(); this.debugDepth += 1; this.native.pushDebugGroup(label); }
  popDebugGroup(): void { this.active(); if (this.debugDepth === 0) throw new Error('WebGPU compute pass has no debug group to pop.'); this.debugDepth -= 1; this.native.popDebugGroup(); }
  setPipeline(pipeline: RHIComputePipeline): void { this.active(); this.pipeline = pipeline; this.native.setPipeline(this.handle(pipeline)); }
  setBindGroup(index: number, group: RHIBindGroup, offsets: readonly number[] = []): void { this.active(); for (const entry of group.descriptor.entries) this.encoder.lease('buffer' in entry.resource ? entry.resource.buffer : entry.resource); this.native.setBindGroup(index, this.handle(group), offsets); }
  dispatchWorkgroups(x: number, y = 1, z = 1): void { this.active(); this.requirePipeline(); this.native.dispatchWorkgroups(x, y, z); this.encoder.dispatch(false); }
  dispatchWorkgroupsIndirect(buffer: RHIBuffer, offset: number): void { this.active(); this.requirePipeline(); this.native.dispatchWorkgroupsIndirect(this.handle(buffer), offset); this.encoder.dispatch(true); }
  end(): void { this.active(); if (this.debugDepth > 0) throw new Error('WebGPU compute pass has unclosed debug groups.'); this.ended = true; this.native.end(); this.encoder.endPass(); }
  private active(): void { if (this.ended) throw new Error('WebGPU compute pass has already ended.'); this.encoder.assertPassActive(); }
  private requirePipeline(): void { if (this.pipeline === undefined) throw new Error('WebGPU compute pass requires a pipeline before dispatch.'); }
  private handle(resource: RHIResource) { return this.encoder.nativeHandle(resource); }
}
