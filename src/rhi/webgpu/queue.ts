import type { RHICommandBuffer } from '../command-types';
import type { RHIQueue } from '../device-types';
import type { GPUImageCopyTexture, RHIBuffer } from '../resource-types';
import type { RHIQueueMetrics, RHISubmission, RHISubmissionStatus } from '../submission-types';
import type { BufferWriteRange, GPUExtent3D, GPUImageDataLayout, RHIUploadData } from '../webgpu-types';
import { WebGPUCommandBuffer } from './command';
import type { WebGPUNativeQueuePort, WebGPUNativeResourcePort } from './native-types';
import {
  WebGPUResourceBase,
  assertWebGPUResource,
  getWebGPUNativeHandle,
  releaseWebGPUNativeHandle,
  type WebGPUDeviceOwner
} from './resource';
import { WebGPUSubmission } from './submission';

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
    private readonly native: WebGPUNativeQueuePort
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
        throw new Error(`Command buffer "${commandBuffer.label ?? 'command-buffer'}" has already been submitted.`);
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
    return Object.freeze({
      submitted: this.submittedCount,
      pending: this.pending.size,
      completed: this.completedCount,
      failed: this.failedCount,
      deviceLost: this.deviceLostCount,
      leasedResources
    });
  }

  writeBuffer(_buffer: RHIBuffer, _offset: number, _data: RHIUploadData): void {
    return pending('queue.writeBuffer');
  }

  writeBufferRanges(_buffer: RHIBuffer, _ranges: readonly BufferWriteRange[]): void {
    return pending('queue.writeBufferRanges');
  }

  writeTexture(
    _destination: GPUImageCopyTexture,
    _data: RHIUploadData,
    _dataLayout: GPUImageDataLayout,
    _size: GPUExtent3D
  ): void {
    return pending('queue.writeTexture');
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

function pending<T>(operation: string): T {
  throw new Error(`WebGPU backend operation ${operation} is not implemented yet.`);
}
