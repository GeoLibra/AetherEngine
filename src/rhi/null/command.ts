import { validateBufferCopy } from './buffer';
import { NullComputePassEncoder, NullPassEncoder, NullRenderPassEncoder } from './passes';
import { normalizeAndValidateExtent, validateTextureCopyView } from './texture';
import { assertResourceLive, assertResourceOwnedBy, NullResourceBase, toResourceRef } from '../resource';
import type { NullDeviceOwner } from '../resource';
import { assertRHIFeature } from '../capability-validation';
import {
  cloneCommandStats,
  createCommandStats,
  recordDraw,
  recordIndexedDraw,
  recordIndirectDraw
} from '../stats';
import type {
  GPUCommandBufferDescriptor,
  GPUCommandEncoderDescriptor,
  GPUComputePassDescriptor,
  GPUExtent3D,
  GPUImageCopyTexture,
  GPUPrimitiveTopology,
  RHICommandBuffer,
  RHICommandEncoder,
  RHICommandRecord,
  RHICommandStats,
  RHIComputePassEncoder,
  RHIBuffer,
  RHIResource,
  RHIRenderPassDescriptor,
  RHIRenderPassEncoder
} from '../types';

export class NullCommandBuffer extends NullResourceBase implements RHICommandBuffer {
  readonly kind = 'command-buffer';

  constructor(
    id: number,
    owner: NullDeviceOwner,
    label: string | undefined,
    private readonly records: readonly RHICommandRecord[],
    private readonly stats: RHICommandStats,
    private readonly leasedResources: readonly RHIResource[]
  ) {
    super(id, owner, label);
  }

  private submitted = false;

  getLeasedResources(): readonly RHIResource[] {
    return this.leasedResources;
  }

  assertReadyForSubmit(): void {
    if (this.submitted) {
      throw new Error(`Command buffer "${this.label ?? 'command-buffer'}" has already been submitted.`);
    }
  }

  markSubmitted(): void {
    this.assertReadyForSubmit();
    this.submitted = true;
  }

  getStats(): RHICommandStats {
    assertResourceLive(this);
    return cloneCommandStats(this.stats);
  }

  getCommandStream(): readonly RHICommandRecord[] {
    assertResourceLive(this);
    return this.records.map(cloneCommandRecord);
  }

  toCommandStreamJSON(): string {
    return JSON.stringify(this.getCommandStream());
  }
}

export class NullCommandEncoder implements RHICommandEncoder {
  private readonly records: RHICommandRecord[] = [];
  private readonly stats = createCommandStats();
  private readonly leasedResources = new Set<RHIResource>();
  private readonly label?: string;
  private activePass: NullPassEncoder | undefined;
  private finished = false;
  private debugGroupDepth = 0;

  constructor(
    private readonly id: number,
    private readonly owner: NullDeviceOwner,
    descriptor: GPUCommandEncoderDescriptor
  ) {
    if (descriptor.label !== undefined) {
      this.label = descriptor.label;
    }
  }

  get ownerToken(): NullDeviceOwner {
    return this.owner;
  }

  beginRenderPass(descriptor: RHIRenderPassDescriptor): RHIRenderPassEncoder {
    this.ensureCanBeginPass('render');
    validateRenderPassDescriptorResources(descriptor, this.owner);
    for (const attachment of descriptor.colorAttachments) {
      this.lease(attachment.view);
      if (attachment.resolveTarget !== undefined) this.lease(attachment.resolveTarget);
    }
    if (descriptor.depthStencilAttachment !== undefined) this.lease(descriptor.depthStencilAttachment.view);
    const pass = new NullRenderPassEncoder(this, descriptor);
    this.stats.renderPasses += 1;
    this.record(withOptionalLabel({ kind: 'beginRenderPass', colorAttachmentCount: descriptor.colorAttachments.length }, descriptor.label));
    this.activePass = pass;
    return pass;
  }

  beginComputePass(descriptor: GPUComputePassDescriptor = {}): RHIComputePassEncoder {
    this.ensureCanBeginPass('compute');
    assertRHIFeature(this.owner, 'compute', 'begin-compute-pass');
    this.stats.computePasses += 1;
    this.record(withOptionalLabel({ kind: 'beginComputePass' }, descriptor.label));
    const pass = new NullComputePassEncoder(this, descriptor.label);
    this.activePass = pass;
    return pass;
  }

  pushDebugGroup(groupLabel: string): void {
    this.ensureCanRecord();
    this.ensureNoActivePass('push an encoder debug group');
    this.debugGroupDepth += 1;
    this.record({ kind: 'pushDebugGroup', scope: 'encoder', label: groupLabel });
  }

  popDebugGroup(): void {
    this.ensureCanRecord();
    this.ensureNoActivePass('pop an encoder debug group');
    if (this.debugGroupDepth === 0) {
      throw new Error(`Command encoder "${this.label ?? this.id}" has no debug group to pop.`);
    }
    this.debugGroupDepth -= 1;
    this.record({ kind: 'popDebugGroup', scope: 'encoder' });
  }

  copyBufferToBuffer(
    source: RHIBuffer,
    sourceOffset: number,
    destination: RHIBuffer,
    destinationOffset: number,
    size: number
  ): void {
    this.ensureCanRecord();
    this.ensureNoActivePass('copy buffers');
    validateBufferCopy(source, sourceOffset, destination, destinationOffset, size, this.owner);
    this.lease(source);
    this.lease(destination);
    this.stats.copy.copyBufferToBuffer += 1;
    this.record({
      kind: 'copyBufferToBuffer',
      source: toResourceRef(source),
      sourceOffset,
      destination: toResourceRef(destination),
      destinationOffset,
      size
    });
  }

  copyTextureToTexture(
    source: GPUImageCopyTexture,
    destination: GPUImageCopyTexture,
    copySize: GPUExtent3D
  ): void {
    this.ensureCanRecord();
    this.ensureNoActivePass('copy textures');
    const normalizedSize = normalizeAndValidateExtent(copySize);
    const normalizedSource = validateTextureCopyView(source, this.owner, normalizedSize);
    const normalizedDestination = validateTextureCopyView(destination, this.owner, normalizedSize);
    this.lease(source.texture);
    this.lease(destination.texture);
    this.stats.copy.copyTextureToTexture += 1;
    this.record({
      kind: 'copyTextureToTexture',
      source: normalizedSource,
      destination: normalizedDestination,
      copySize: normalizedSize
    });
  }

  finish(descriptor: GPUCommandBufferDescriptor = {}): RHICommandBuffer {
    this.ensureCanRecord();
    if (this.activePass !== undefined) {
      throw new Error('Cannot finish command encoder while a pass is active.');
    }
    if (this.debugGroupDepth > 0) {
      throw new Error(`Command encoder "${this.label ?? this.id}" has unclosed debug groups.`);
    }
    this.finished = true;
    return new NullCommandBuffer(
      this.id,
      this.owner,
      descriptor.label,
      this.records.map(cloneCommandRecord),
      cloneCommandStats(this.stats),
      [...this.leasedResources]
    );
  }

  getStats(): RHICommandStats {
    return cloneCommandStats(this.stats);
  }

  record(record: RHICommandRecord): void {
    this.records.push(record);
  }

  lease(resource: RHIResource): void {
    this.leasedResources.add(resource);
  }

  recordDraw(vertexCount: number, instanceCount: number, topology: GPUPrimitiveTopology | undefined): void {
    recordDraw(this.stats, vertexCount, instanceCount, topology);
  }

  recordIndexedDraw(indexCount: number, instanceCount: number, topology: GPUPrimitiveTopology | undefined): void {
    recordIndexedDraw(this.stats, indexCount, instanceCount, topology);
  }

  recordIndirectDraw(): void {
    recordIndirectDraw(this.stats);
  }

  recordDispatchWorkgroups(): void {
    this.stats.compute.dispatchWorkgroups += 1;
  }

  recordDispatchWorkgroupsIndirect(): void {
    this.stats.compute.dispatchWorkgroupsIndirect += 1;
  }

  endPass(pass: NullPassEncoder): void {
    if (this.activePass !== pass) {
      throw new Error('Cannot end a pass that is not active.');
    }
    this.activePass = undefined;
  }

  private ensureCanBeginPass(kind: 'render' | 'compute'): void {
    this.ensureCanRecord();
    if (this.activePass !== undefined) {
      throw new Error(`Cannot begin a ${kind} pass while another pass is active.`);
    }
  }

  private ensureCanRecord(): void {
    if (this.owner.state !== 'live') {
      throw new Error(`Command encoder "${this.label ?? this.id}" belongs to a lost device.`);
    }
    if (this.finished) {
      throw new Error(`Command encoder "${this.label ?? this.id}" has already finished.`);
    }
  }

  private ensureNoActivePass(action: string): void {
    if (this.activePass !== undefined) {
      throw new Error(`Cannot ${action} while a pass is active.`);
    }
  }
}

function withOptionalLabel<T extends { kind: string }>(record: T, label: string | undefined): T & { label?: string } {
  if (label === undefined) {
    return record;
  }
  return { ...record, label };
}

function cloneCommandRecord(record: RHICommandRecord): RHICommandRecord {
  return JSON.parse(JSON.stringify(record)) as RHICommandRecord;
}

function validateRenderPassDescriptorResources(descriptor: RHIRenderPassDescriptor, owner: NullDeviceOwner): void {
  for (const attachment of descriptor.colorAttachments) {
    assertResourceOwnedBy(attachment.view, owner);
    assertResourceLive(attachment.view);
    if (attachment.resolveTarget !== undefined) {
      assertResourceOwnedBy(attachment.resolveTarget, owner);
      assertResourceLive(attachment.resolveTarget);
    }
  }
  if (descriptor.depthStencilAttachment !== undefined) {
    assertResourceOwnedBy(descriptor.depthStencilAttachment.view, owner);
    assertResourceLive(descriptor.depthStencilAttachment.view);
  }
}
