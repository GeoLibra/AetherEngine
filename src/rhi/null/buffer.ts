import { assertResourceLive, assertResourceOwnedBy, NullResourceBase } from './resource';
import type { NullDeviceOwner } from './resource';
import type {
  GPUBufferDescriptor,
  GPUBufferUsageFlags,
  GPUMapModeFlags,
  RHIBuffer,
  RHIUploadData
} from '../contracts';

export class NullBuffer extends NullResourceBase implements RHIBuffer {
  readonly kind = 'buffer';
  readonly descriptor: Readonly<GPUBufferDescriptor>;
  readonly size: number;
  readonly usage: GPUBufferUsageFlags;
  private readonly storage: ArrayBuffer;
  private mappedRange: ArrayBuffer | undefined;
  private mappedOffset = 0;
  private mappedSize = 0;
  private readonly mappedViews: Array<{ offset: number; data: ArrayBuffer }> = [];

  constructor(id: number, owner: NullDeviceOwner, descriptor: GPUBufferDescriptor) {
    super(id, owner, descriptor.label);
    this.descriptor = { ...descriptor };
    this.size = descriptor.size;
    this.usage = descriptor.usage;
    this.storage = new ArrayBuffer(descriptor.size);
    if (descriptor.mappedAtCreation === true) {
      this.mappedRange = this.storage.slice(0, descriptor.size);
      this.mappedOffset = 0;
      this.mappedSize = descriptor.size;
    }
  }

  mapAsync(_mode: GPUMapModeFlags, offset = 0, size = this.size - offset): Promise<void> {
    this.ensureLive();
    if (this.isMapped) {
      throw new Error(`Buffer "${this.label ?? this.id}" is already mapped.`);
    }
    validateBufferRange(offset, size, this.size);
    this.mappedRange = this.storage.slice(offset, offset + size);
    this.mappedOffset = offset;
    this.mappedSize = size;
    this.mappedViews.length = 0;
    return Promise.resolve();
  }

  getMappedRange(
    offset = this.mappedOffset,
    size = this.mappedSize - (offset - this.mappedOffset)
  ): ArrayBuffer {
    this.ensureLive();
    if (this.mappedRange === undefined) {
      throw new Error(`Buffer "${this.label ?? this.id}" is not mapped.`);
    }
    validateBufferRange(offset, size, this.size);
    if (offset < this.mappedOffset || offset + size > this.mappedOffset + this.mappedSize) {
      throw new Error(
        `Mapped range ${offset}..${offset + size} is outside mapped buffer range ${this.mappedOffset}..${this.mappedOffset + this.mappedSize}.`
      );
    }
    const relativeOffset = offset - this.mappedOffset;
    const data = this.mappedRange.slice(relativeOffset, relativeOffset + size);
    this.mappedViews.push({ offset, data });
    return data;
  }

  unmap(): void {
    this.ensureLive();
    this.flushMappedViews();
    this.mappedRange = undefined;
    this.mappedOffset = 0;
    this.mappedSize = 0;
    this.mappedViews.length = 0;
  }

  get isMapped(): boolean {
    return this.mappedRange !== undefined;
  }

  writeBytes(offset: number, data: Uint8Array): void {
    this.ensureLive();
    if (this.isMapped) {
      throw new Error(`Buffer "${this.label ?? this.id}" is currently mapped.`);
    }
    validateBufferRange(offset, data.byteLength, this.size);
    new Uint8Array(this.storage).set(data, offset);
  }

  private ensureLive(): void {
    assertResourceLive(this);
  }

  private flushMappedViews(): void {
    if (this.mappedRange === undefined) {
      return;
    }
    const target = new Uint8Array(this.mappedRange);
    for (const view of this.mappedViews) {
      const relativeOffset = view.offset - this.mappedOffset;
      target.set(new Uint8Array(view.data), relativeOffset);
    }
    new Uint8Array(this.storage).set(target, this.mappedOffset);
  }
}

export function validateBufferRange(offset: number, size: number, bufferSize: number): void {
  if (
    !Number.isInteger(offset) ||
    !Number.isInteger(size) ||
    offset < 0 ||
    size < 0 ||
    offset + size > bufferSize
  ) {
    throw new Error(
      `Buffer range ${offset}..${offset + size} is outside buffer size ${bufferSize}.`
    );
  }
}

export function toByteCopy(data: RHIUploadData): Uint8Array {
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return new Uint8Array(data.slice(0));
}

export function validateBufferForQueueWrite(buffer: RHIBuffer, owner: NullDeviceOwner): NullBuffer {
  assertResourceOwnedBy(buffer, owner);
  assertResourceLive(buffer);
  assertBufferUnmapped(buffer);
  if (!(buffer instanceof NullBuffer)) {
    throw new Error(`Resource "${buffer.label ?? buffer.kind}" was not created by NullDevice.`);
  }
  return buffer;
}

export function validateBufferCopy(
  source: RHIBuffer,
  sourceOffset: number,
  destination: RHIBuffer,
  destinationOffset: number,
  size: number,
  owner: NullDeviceOwner
): void {
  assertResourceOwnedBy(source, owner);
  assertResourceLive(source);
  assertBufferUnmapped(source);
  assertResourceOwnedBy(destination, owner);
  assertResourceLive(destination);
  assertBufferUnmapped(destination);
  validateBufferRange(sourceOffset, size, source.size);
  validateBufferRange(destinationOffset, size, destination.size);
}

export function assertBufferUnmapped(buffer: RHIBuffer): void {
  if (buffer instanceof NullBuffer && buffer.isMapped) {
    throw new Error(`Buffer "${buffer.label ?? buffer.id}" is currently mapped.`);
  }
}
