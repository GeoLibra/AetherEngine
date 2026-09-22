import type { RHICommandBuffer } from '../contracts/command';
import type { RHIQueue } from '../contracts/device';
import type { GPUImageCopyTexture, RHIBuffer } from '../contracts/resource';
import type { RHIQueueMetrics, RHISubmission, RHISubmissionStatus } from '../contracts/submission';
import type {
  BufferWriteRange,
  GPUExtent3D,
  GPUImageDataLayout,
  RHIUploadData
} from '../contracts/webgpu';
import { WebGPUCommandBuffer } from './command';
import type { WebGPUNativeQueuePort, WebGPUNativeResourcePort } from './types';
import {
  WebGPUBuffer,
  WebGPUResourceBase,
  WebGPUTexture,
  assertWebGPUResource,
  getWebGPUNativeHandle,
  releaseWebGPUNativeHandle,
  type WebGPUDeviceOwner
} from './resource';
import { WebGPUSubmission } from './submission';
import type { WebGPUFastPathCounter } from './metrics';
import {
  copyUploadBytes,
  lowerAndValidateTextureDestination,
  normalizeUploadExtent,
  validateUploadBufferRange,
  validateUploadDataLayout
} from './upload-validation';

interface PendingEpoch {
  readonly submission: WebGPUSubmission;
  readonly resources: Set<WebGPUResourceBase>;
}

type TerminalStatus = Exclude<RHISubmissionStatus, 'pending'>;

export class WebGPUQueue implements RHIQueue {
  private readonly pending = new Map<number, PendingEpoch>();
  private readonly leaseCounts = new Map<WebGPUResourceBase, number>();
  private readonly deferredDestruction = new Map<WebGPUResourceBase, WebGPUNativeResourcePort>();
  private nextSubmissionId = 1;
  private submittedCount = 0;
  private completedCount = 0;
  private failedCount = 0;
  private deviceLostCount = 0;

  constructor(
    private readonly owner: WebGPUDeviceOwner,
    private readonly native: WebGPUNativeQueuePort,
    private readonly fastPath: WebGPUFastPathCounter
  ) {}

  submit(commandBuffers: readonly RHICommandBuffer[]): RHISubmission {
    if (this.owner.state !== 'live') throw new Error('WebGPUQueue belongs to a lost device.');

    const validated: WebGPUCommandBuffer[] = [];
    const nativeCommands: WebGPUNativeResourcePort[] = [];
    const resources = new Set<WebGPUResourceBase>();
    const seen = new Set<RHICommandBuffer>();

    // Validate the entire logical submission before mutating command-buffer state or touching native queue state.
    for (const commandBuffer of commandBuffers) {
      const webgpuCommandBuffer = assertWebGPUCommandBuffer(commandBuffer, this.owner);
      if (seen.has(commandBuffer)) {
        throw new Error(
          `Command buffer "${commandBuffer.label ?? 'command-buffer'}" has already been submitted.`
        );
      }
      seen.add(commandBuffer);
      webgpuCommandBuffer.assertReadyForSubmit();
      resources.add(webgpuCommandBuffer);
      for (const lease of webgpuCommandBuffer.getLeases()) {
        resources.add(assertWebGPUResource(lease, this.owner));
      }
      validated.push(webgpuCommandBuffer);
      nativeCommands.push(getWebGPUNativeHandle(webgpuCommandBuffer, this.owner));
    }

    const submission = new WebGPUSubmission(this.nextSubmissionId++);
    const epoch: PendingEpoch = { submission, resources };
    for (const commandBuffer of validated) commandBuffer.markSubmitted();
    for (const resource of resources) this.retain(resource);
    this.pending.set(submission.id, epoch);
    this.submittedCount += 1;

    try {
      // A logical submission is deliberately never split into multiple native queue submissions.
      this.native.submit(nativeCommands);
      this.fastPath.recordSubmit();
      void this.native.onSubmittedWorkDone().then(
        () => this.settle(epoch, 'completed'),
        (error: unknown) => this.settle(epoch, 'failed', error)
      );
    } catch (error) {
      this.settle(epoch, 'failed', error);
    }
    return submission;
  }

  metrics(): RHIQueueMetrics {
    let leasedResources = 0;
    for (const epoch of this.pending.values()) leasedResources += epoch.resources.size;
    const upload = this.fastPath.snapshot();
    return Object.freeze({
      uploadCalls: upload.uploadCalls,
      uploadBytes: upload.uploadBytes,
      submitted: this.submittedCount,
      pending: this.pending.size,
      completed: this.completedCount,
      failed: this.failedCount,
      deviceLost: this.deviceLostCount,
      leasedResources
    });
  }

  writeBuffer(buffer: RHIBuffer, offset: number, data: RHIUploadData): void {
    const target = this.validateUploadBuffer(buffer);
    const bytes = copyUploadBytes(data);
    validateUploadBufferRange(offset, bytes.byteLength, buffer.size);
    const write = this.native.writeBuffer;
    if (write === undefined) throw new Error('Native WebGPU queue does not support writeBuffer.');
    write.call(this.native, getWebGPUNativeHandle(target, this.owner), offset, bytes);
    this.fastPath.recordUpload(bytes.byteLength);
  }

  writeBufferRanges(buffer: RHIBuffer, ranges: readonly BufferWriteRange[]): void {
    const target = this.validateUploadBuffer(buffer);
    const writes = ranges.map((range) => {
      const bytes = copyUploadBytes(range.data);
      validateUploadBufferRange(range.offset, bytes.byteLength, buffer.size);
      return { offset: range.offset, bytes };
    });
    const write = this.native.writeBuffer;
    if (write === undefined) throw new Error('Native WebGPU queue does not support writeBuffer.');
    const native = getWebGPUNativeHandle(target, this.owner);
    for (const entry of writes) {
      write.call(this.native, native, entry.offset, entry.bytes);
      this.fastPath.recordUpload(entry.bytes.byteLength);
    }
  }

  writeTexture(
    destination: GPUImageCopyTexture,
    data: RHIUploadData,
    dataLayout: GPUImageDataLayout,
    size: GPUExtent3D
  ): void {
    validateUploadDataLayout(dataLayout);
    const copySize = normalizeUploadExtent(size);
    const resource = assertWebGPUResource(destination.texture, this.owner);
    if (!(resource instanceof WebGPUTexture)) {
      throw new Error('WebGPUQueue only accepts textures created by WebGPUDevice.');
    }
    const lowered = lowerAndValidateTextureDestination(
      destination,
      destination.texture,
      getWebGPUNativeHandle(resource, this.owner),
      copySize
    );
    const bytes = copyUploadBytes(data);
    const write = this.native.writeTexture;
    if (write === undefined) throw new Error('Native WebGPU queue does not support writeTexture.');
    write.call(this.native, lowered, bytes, Object.freeze({ ...dataLayout }), copySize);
    this.fastPath.recordUpload(bytes.byteLength);
  }

  disposeResource(resource: WebGPUResourceBase, native: WebGPUNativeResourcePort): void {
    if ((this.leaseCounts.get(resource) ?? 0) > 0) {
      this.deferredDestruction.set(resource, native);
      return;
    }
    releaseWebGPUNativeHandle(resource, native);
  }

  handleDeviceLoss(): void {
    for (const epoch of [...this.pending.values()]) this.settle(epoch, 'device-lost');
  }

  private retain(resource: WebGPUResourceBase): void {
    this.leaseCounts.set(resource, (this.leaseCounts.get(resource) ?? 0) + 1);
  }

  private validateUploadBuffer(buffer: RHIBuffer): WebGPUBuffer {
    const resource = assertWebGPUResource(buffer, this.owner);
    if (!(resource instanceof WebGPUBuffer)) {
      throw new Error('WebGPUQueue only accepts buffers created by WebGPUDevice.');
    }
    if (resource.isMapped)
      throw new Error(`Buffer "${buffer.label ?? buffer.id}" is currently mapped.`);
    return resource;
  }

  private release(resource: WebGPUResourceBase): void {
    const next = (this.leaseCounts.get(resource) ?? 1) - 1;
    if (next > 0) {
      this.leaseCounts.set(resource, next);
      return;
    }
    this.leaseCounts.delete(resource);
    const native = this.deferredDestruction.get(resource);
    if (native === undefined) return;
    this.deferredDestruction.delete(resource);
    releaseWebGPUNativeHandle(resource, native);
  }

  private settle(epoch: PendingEpoch, status: TerminalStatus, error?: unknown): void {
    if (!this.pending.delete(epoch.submission.id)) return;
    for (const resource of epoch.resources) this.release(resource);
    if (status === 'completed') this.completedCount += 1;
    if (status === 'failed') this.failedCount += 1;
    if (status === 'device-lost') this.deviceLostCount += 1;
    epoch.submission.settle(status, error);
  }
}

function assertWebGPUCommandBuffer(
  commandBuffer: RHICommandBuffer,
  owner: WebGPUDeviceOwner
): WebGPUCommandBuffer {
  assertWebGPUResource(commandBuffer, owner);
  if (!(commandBuffer instanceof WebGPUCommandBuffer)) {
    throw new Error('WebGPUQueue only accepts command buffers created by WebGPUDevice.');
  }
  return commandBuffer;
}
