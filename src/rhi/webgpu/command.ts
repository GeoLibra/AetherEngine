import type {
  RHICommandBuffer,
  RHICommandEncoder,
  RHICommandRecord,
  RHICommandStats,
  RHIComputePassEncoder,
  RHIRenderPassEncoder,
} from '../contracts/command';
import type {
  RHIResource,
  RHIRenderPipeline,
  RHIBuffer,
  GPUImageCopyTexture,
} from '../contracts/resource';
import type { RHIRenderPassDescriptor } from '../contracts/render-target';
import type {
  GPUCommandBufferDescriptor,
  GPUComputePassDescriptor,
  GPUExtent3D,
} from '../contracts/webgpu';
import {
  cloneCommandStats,
  createCommandStats,
  recordDraw,
  recordIndexedDraw,
  recordIndirectDraw,
} from '../core/stats';
import type {
  WebGPUNativeCommandEncoderPort,
  WebGPUNativeResourcePort,
} from './native-types';
import {
  WebGPUBuffer,
  WebGPUResourceBase,
  getWebGPUNativeHandle,
  type WebGPUDeviceOwner,
} from './resource';
import type { WebGPUFastPathCounter } from './metrics';
import { WebGPUComputePass, WebGPURenderPass } from './passes';
import {
  lowerAndValidateTextureDestination,
  normalizeUploadExtent,
  validateUploadBufferRange,
} from './upload-validation';

interface EncoderInteropState {
  readonly owner: WebGPUDeviceOwner;
  readonly native: WebGPUNativeCommandEncoderPort;
  readonly assertAvailable: () => void;
}

const encoderInteropState = new WeakMap<
  WebGPUCommandEncoder,
  EncoderInteropState
>();

export class WebGPUCommandBuffer
  extends WebGPUResourceBase
  implements RHICommandBuffer
{
  readonly kind = 'command-buffer';
  private submitted = false;
  constructor(
    id: number,
    owner: WebGPUDeviceOwner,
    native: WebGPUNativeResourcePort,
    label: string | undefined,
    private readonly stats: RHICommandStats,
    private readonly leases: readonly RHIResource[]
  ) {
    super(id, owner, native, label);
  }
  getStats(): RHICommandStats {
    return cloneCommandStats(this.stats);
  }
  getCommandStream(): readonly RHICommandRecord[] {
    return Object.freeze([]);
  }
  toCommandStreamJSON(): string {
    return '[]';
  }
  getLeases(): readonly RHIResource[] {
    return this.leases;
  }
  assertReadyForSubmit(): void {
    if (this.submitted)
      throw new Error(
        `Command buffer "${this.label ?? 'command-buffer'}" has already been submitted.`
      );
  }
  markSubmitted(): void {
    this.assertReadyForSubmit();
    this.submitted = true;
  }
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
    private readonly fastPath: WebGPUFastPathCounter
  ) {
    encoderInteropState.set(this, {
      owner,
      native,
      assertAvailable: () => this.ensureIdle(),
    });
  }

  beginRenderPass(descriptor: RHIRenderPassDescriptor): RHIRenderPassEncoder {
    this.beginPass();
    const colorAttachments = descriptor.colorAttachments.map((attachment) => {
      this.lease(attachment.view);
      if (attachment.resolveTarget !== undefined)
        this.lease(attachment.resolveTarget);
      return Object.freeze({
        ...attachment,
        view: getWebGPUNativeHandle(attachment.view, this.owner),
        ...(attachment.resolveTarget === undefined
          ? {}
          : {
              resolveTarget: getWebGPUNativeHandle(
                attachment.resolveTarget,
                this.owner
              ),
            }),
      });
    });
    const lowered: Record<string, unknown> = {
      colorAttachments: Object.freeze(colorAttachments),
    };
    if (descriptor.label !== undefined) lowered.label = descriptor.label;
    if (descriptor.depthStencilAttachment !== undefined) {
      this.lease(descriptor.depthStencilAttachment.view);
      lowered.depthStencilAttachment = Object.freeze({
        ...descriptor.depthStencilAttachment,
        view: getWebGPUNativeHandle(
          descriptor.depthStencilAttachment.view,
          this.owner
        ),
      });
    }
    this.stats.renderPasses += 1;
    const nativePass = this.native.beginRenderPass(Object.freeze(lowered));
    this.fastPath.recordPassWrapper();
    return new WebGPURenderPass(this, nativePass);
  }

  beginComputePass(
    descriptor: GPUComputePassDescriptor = {}
  ): RHIComputePassEncoder {
    this.beginPass();
    this.stats.computePasses += 1;
    const nativePass = this.native.beginComputePass(
      Object.freeze({ ...descriptor })
    );
    this.fastPath.recordPassWrapper();
    return new WebGPUComputePass(this, nativePass);
  }
  pushDebugGroup(label: string): void {
    this.ensureOpen();
    this.debugDepth += 1;
    this.native.pushDebugGroup(label);
  }
  popDebugGroup(): void {
    this.ensureOpen();
    if (this.debugDepth === 0)
      throw new Error('WebGPU command encoder has no debug group to pop.');
    this.debugDepth -= 1;
    this.native.popDebugGroup();
  }
  copyBufferToBuffer(
    source: RHIBuffer,
    sourceOffset: number,
    destination: RHIBuffer,
    destinationOffset: number,
    size: number
  ): void {
    this.ensureIdle();
    this.validateCopyBuffer(source, sourceOffset, size);
    this.validateCopyBuffer(destination, destinationOffset, size);
    this.lease(source);
    this.lease(destination);
    this.native.copyBufferToBuffer(
      getWebGPUNativeHandle(source, this.owner),
      sourceOffset,
      getWebGPUNativeHandle(destination, this.owner),
      destinationOffset,
      size
    );
    this.stats.copy.copyBufferToBuffer += 1;
  }
  copyTextureToTexture(
    source: GPUImageCopyTexture,
    destination: GPUImageCopyTexture,
    copySize: GPUExtent3D
  ): void {
    this.ensureIdle();
    const extent = normalizeUploadExtent(copySize);
    const nativeSource = getWebGPUNativeHandle(source.texture, this.owner);
    const nativeDestination = getWebGPUNativeHandle(
      destination.texture,
      this.owner
    );
    const loweredSource = lowerAndValidateTextureDestination(
      source,
      source.texture,
      nativeSource,
      extent
    );
    const loweredDestination = lowerAndValidateTextureDestination(
      destination,
      destination.texture,
      nativeDestination,
      extent
    );
    this.lease(source.texture);
    this.lease(destination.texture);
    this.native.copyTextureToTexture(loweredSource, loweredDestination, extent);
    this.stats.copy.copyTextureToTexture += 1;
  }
  finish(descriptor: GPUCommandBufferDescriptor = {}): RHICommandBuffer {
    this.ensureIdle();
    if (this.debugDepth > 0)
      throw new Error('WebGPU command encoder has unclosed debug groups.');
    this.finished = true;
    const nativeCommandBuffer = this.native.finish(
      Object.freeze({ ...descriptor })
    );
    this.fastPath.recordCommandBuffer();
    return new WebGPUCommandBuffer(
      this.id,
      this.owner,
      nativeCommandBuffer,
      descriptor.label,
      cloneCommandStats(this.stats),
      Object.freeze([...this.leases])
    );
  }
  getStats(): RHICommandStats {
    return cloneCommandStats(this.stats);
  }
  lease(resource: RHIResource): void {
    getWebGPUNativeHandle(resource, this.owner);
    this.leases.add(resource);
  }
  nativeHandle(resource: RHIResource): WebGPUNativeResourcePort {
    this.lease(resource);
    return getWebGPUNativeHandle(resource, this.owner);
  }
  assertPassActive(): void {
    this.ensureOpen();
  }
  endPass(): void {
    this.activePass = false;
  }
  draw(
    vertices: number,
    instances: number,
    topology: RHIRenderPipeline['topology']
  ): void {
    recordDraw(this.stats, vertices, instances, topology);
  }
  drawIndexed(
    indices: number,
    instances: number,
    topology: RHIRenderPipeline['topology']
  ): void {
    recordIndexedDraw(this.stats, indices, instances, topology);
  }
  drawIndirect(): void {
    recordIndirectDraw(this.stats);
  }
  dispatch(indirect: boolean): void {
    if (indirect) this.stats.compute.dispatchWorkgroupsIndirect += 1;
    else this.stats.compute.dispatchWorkgroups += 1;
  }
  private beginPass(): void {
    this.ensureIdle();
    this.activePass = true;
  }
  private ensureOpen(): void {
    if (this.finished)
      throw new Error('WebGPU command encoder has already finished.');
    if (this.owner.state !== 'live')
      throw new Error('WebGPU command encoder belongs to a lost device.');
  }
  private ensureIdle(): void {
    this.ensureOpen();
    if (this.activePass)
      throw new Error('WebGPU command encoder has an active pass.');
  }
  private validateCopyBuffer(
    buffer: RHIBuffer,
    offset: number,
    size: number
  ): void {
    getWebGPUNativeHandle(buffer, this.owner);
    if (!(buffer instanceof WebGPUBuffer)) {
      throw new Error(
        'WebGPU command encoder only accepts buffers created by WebGPUDevice.'
      );
    }
    if (buffer.isMapped)
      throw new Error(
        `Buffer "${buffer.label ?? buffer.id}" is currently mapped.`
      );
    validateUploadBufferRange(offset, size, buffer.size);
  }
}

export function getWebGPUNativeCommandEncoder(
  encoder: RHICommandEncoder,
  owner: WebGPUDeviceOwner
): WebGPUNativeCommandEncoderPort {
  if (!(encoder instanceof WebGPUCommandEncoder)) {
    throw new Error('Command encoder was not created by WebGPUDevice.');
  }
  const state = encoderInteropState.get(encoder);
  if (state === undefined)
    throw new Error('WebGPU command encoder has no native handle.');
  if (state.owner !== owner)
    throw new Error('Command encoder belongs to a different WebGPUDevice.');
  state.assertAvailable();
  return state.native;
}
