import { toByteCopy, validateBufferForQueueWrite, validateBufferRange } from './buffer';
import { normalizeAndValidateExtent, validateImageDataLayout, validateTextureCopyView } from './texture';
import { assertResourceLive, assertResourceOwnedBy } from '../resource';
import type { NullDeviceOwner } from '../resource';
import type {
  BufferWriteRange,
  GPUImageCopyTexture,
  GPUImageDataLayout,
  GPUExtent3D,
  RHICommandBuffer,
  RHIBuffer,
  RHIQueue,
  RHIUploadData
} from '../types';

export class NullQueue implements RHIQueue {
  private readonly submitted: RHICommandBuffer[] = [];

  constructor(private readonly owner: NullDeviceOwner) {}

  submit(commandBuffers: readonly RHICommandBuffer[]): void {
    for (const commandBuffer of commandBuffers) {
      assertResourceOwnedBy(commandBuffer, this.owner);
      assertResourceLive(commandBuffer);
    }
    this.submitted.push(...commandBuffers);
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
}
