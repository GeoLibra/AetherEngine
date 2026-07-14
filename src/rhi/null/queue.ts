import { toByteCopy, validateBufferForQueueWrite, validateBufferRange } from './buffer';
import { normalizeAndValidateExtent, validateImageDataLayout, validateTextureCopyView } from './texture';
import { assertResourceLive, assertResourceOwnedBy } from '../resource';
import type { NullDeviceOwner } from '../resource';
import { NullCommandBuffer } from './command';
import { NullSubmission } from './submission';
import type {
  BufferWriteRange,
  GPUImageCopyTexture,
  GPUImageDataLayout,
  GPUExtent3D,
  RHICommandBuffer,
  RHIBuffer,
  RHIQueue,
  RHIQueueMetrics,
  RHIResource,
  RHISubmission,
  RHIUploadData
} from '../types';

export type NullSubmissionMode = 'auto-complete' | 'manual';

interface PendingSubmission {
  readonly submission: NullSubmission;
  readonly resources: Set<RHIResource>;
}

export class NullQueue implements RHIQueue {
  private readonly submitted: RHICommandBuffer[] = [];
  private readonly pending: PendingSubmission[] = [];
  private nextSubmissionId = 1;
  private submittedCount = 0;
  private completedCount = 0;
  private failedCount = 0;
  private deviceLostCount = 0;

  constructor(
    private readonly owner: NullDeviceOwner,
    private readonly submissionMode: NullSubmissionMode = 'auto-complete'
  ) {}

  submit(commandBuffers: readonly RHICommandBuffer[]): RHISubmission {
    const nullCommandBuffers: NullCommandBuffer[] = [];
    const seenCommandBuffers = new Set<RHICommandBuffer>();
    for (const commandBuffer of commandBuffers) {
      assertResourceOwnedBy(commandBuffer, this.owner);
      assertResourceLive(commandBuffer);
      if (!(commandBuffer instanceof NullCommandBuffer)) {
        throw new Error('NullQueue only accepts command buffers created by NullDevice.');
      }
      if (seenCommandBuffers.has(commandBuffer)) {
        throw new Error(`Command buffer "${commandBuffer.label ?? 'command-buffer'}" has already been submitted.`);
      }
      seenCommandBuffers.add(commandBuffer);
      commandBuffer.assertReadyForSubmit();
      for (const resource of commandBuffer.getLeasedResources()) {
        assertResourceOwnedBy(resource, this.owner);
        assertResourceLive(resource);
      }
      nullCommandBuffers.push(commandBuffer);
    }

    const resources = new Set<RHIResource>();
    for (const commandBuffer of nullCommandBuffers) {
      commandBuffer.markSubmitted();
      resources.add(commandBuffer);
      for (const resource of commandBuffer.getLeasedResources()) resources.add(resource);
    }

    this.submitted.push(...commandBuffers);
    const submission = new NullSubmission(this.nextSubmissionId++);
    const pending = { submission, resources };
    this.pending.push(pending);
    this.submittedCount += 1;
    if (this.submissionMode === 'auto-complete') this.settle(pending, 'completed');
    return submission;
  }

  metrics(): RHIQueueMetrics {
    return Object.freeze({
      submitted: this.submittedCount,
      pending: this.pending.length,
      completed: this.completedCount,
      failed: this.failedCount,
      deviceLost: this.deviceLostCount,
      leasedResources: this.pending.reduce((count, entry) => count + entry.resources.size, 0)
    });
  }

  completeNextForTesting(): void {
    this.settleNext('completed');
  }

  failNextForTesting(error: unknown): void {
    this.settleNext('failed', error);
  }

  handleDeviceLoss(): void {
    for (const entry of [...this.pending]) this.settle(entry, 'device-lost');
  }

  writeBuffer(buffer: RHIBuffer, offset: number, data: RHIUploadData): void {
    const target = validateBufferForQueueWrite(buffer, this.owner);
    const bytes = toByteCopy(data);
    validateBufferRange(offset, bytes.byteLength, buffer.size);
    target.writeBytes(offset, bytes);
  }

  writeBufferRanges(buffer: RHIBuffer, ranges: readonly BufferWriteRange[]): void {
    const target = validateBufferForQueueWrite(buffer, this.owner);
    const writes = ranges.map((range) => {
      const bytes = toByteCopy(range.data);
      validateBufferRange(range.offset, bytes.byteLength, buffer.size);
      return { offset: range.offset, bytes };
    });
    for (const write of writes) {
      target.writeBytes(write.offset, write.bytes);
    }
  }

  writeTexture(
    destination: GPUImageCopyTexture,
    _data: RHIUploadData,
    dataLayout: GPUImageDataLayout,
    size: GPUExtent3D
  ): void {
    validateImageDataLayout(dataLayout);
    const normalizedSize = normalizeAndValidateExtent(size);
    validateTextureCopyView(destination, this.owner, normalizedSize);
  }

  private settleNext(status: 'completed' | 'failed', error?: unknown): void {
    const entry = this.pending[0];
    if (entry === undefined) throw new Error('NullQueue has no pending submission.');
    this.settle(entry, status, error);
  }

  private settle(
    entry: PendingSubmission,
    status: 'completed' | 'failed' | 'device-lost',
    error?: unknown
  ): void {
    const index = this.pending.indexOf(entry);
    if (index < 0) return;
    this.pending.splice(index, 1);
    entry.resources.clear();
    if (status === 'completed') this.completedCount += 1;
    if (status === 'failed') this.failedCount += 1;
    if (status === 'device-lost') this.deviceLostCount += 1;
    entry.submission.settle(status, error);
  }
}
