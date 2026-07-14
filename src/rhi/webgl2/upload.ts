import type { RHICommandBuffer } from '../command-types';
import type { RHIQueue } from '../device-types';
import type { GPUImageCopyTexture, RHIBuffer } from '../resource-types';
import type { RHIQueueMetrics, RHISubmission } from '../submission-types';
import type { BufferWriteRange, GPUExtent3D, GPUImageDataLayout, RHIUploadData } from '../webgpu-types';
import { WebGL2Buffer, WebGL2Texture, assertWebGL2Resource, getWebGL2Handle, normalizeExtent } from './resource';
import type { WebGL2DeviceOwner } from './resource-types';
import type { WebGL2NativeContextPort } from './native-types';

export class WebGL2Queue implements RHIQueue {
  constructor(
    private readonly owner: WebGL2DeviceOwner,
    private readonly native: WebGL2NativeContextPort
  ) {}

  submit(_commandBuffers: readonly RHICommandBuffer[]): RHISubmission { return pending('queue.submit'); }
  metrics(): RHIQueueMetrics { return pending('queue.metrics'); }

  writeBuffer(buffer: RHIBuffer, offset: number, data: RHIUploadData): void {
    const target = this.validateBuffer(buffer);
    const bytes = copyBytes(data);
    validateBufferRange(offset, bytes.byteLength, target.size);
    const write = this.native.writeBuffer;
    if (write === undefined) throw new Error('Native WebGL2 context does not support buffer uploads.');
    write.call(this.native, getWebGL2Handle(target, this.owner), offset, bytes);
  }

  writeBufferRanges(buffer: RHIBuffer, ranges: readonly BufferWriteRange[]): void {
    const target = this.validateBuffer(buffer);
    const writes = ranges.map((range) => {
      const bytes = copyBytes(range.data);
      validateBufferRange(range.offset, bytes.byteLength, target.size);
      return { offset: range.offset, bytes };
    });
    const write = this.native.writeBuffer;
    if (write === undefined) throw new Error('Native WebGL2 context does not support buffer uploads.');
    const handle = getWebGL2Handle(target, this.owner);
    for (const entry of writes) write.call(this.native, handle, entry.offset, entry.bytes);
  }

  writeTexture(
    destination: GPUImageCopyTexture,
    data: RHIUploadData,
    dataLayout: GPUImageDataLayout,
    size: GPUExtent3D
  ): void {
    validateDataLayout(dataLayout);
    const copySize = validateExtent(size);
    const resource = assertWebGL2Resource(destination.texture, this.owner);
    if (!(resource instanceof WebGL2Texture)) throw new Error('WebGL2Queue requires a WebGL2 texture.');
    const lowered = lowerTextureDestination(destination, resource, getWebGL2Handle(resource, this.owner), copySize);
    const bytes = copyBytes(data);
    const write = this.native.writeTexture;
    if (write === undefined) throw new Error('Native WebGL2 context does not support texture uploads.');
    write.call(this.native, lowered, bytes, Object.freeze({ ...dataLayout }), copySize);
  }

  private validateBuffer(buffer: RHIBuffer): WebGL2Buffer {
    const resource = assertWebGL2Resource(buffer, this.owner);
    if (!(resource instanceof WebGL2Buffer)) throw new Error('WebGL2Queue requires a WebGL2 buffer.');
    return resource;
  }
}

function copyBytes(data: RHIUploadData): Uint8Array {
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return new Uint8Array(data.slice(0));
}

function validateBufferRange(offset: number, size: number, bufferSize: number): void {
  if (!Number.isInteger(offset) || !Number.isInteger(size) || offset < 0 || size < 0 || offset + size > bufferSize) {
    throw new Error(`Buffer range ${offset}..${offset + size} is outside buffer size ${bufferSize}.`);
  }
}

function validateExtent(size: GPUExtent3D) {
  const extent = normalizeExtent(size);
  if (
    !Number.isInteger(extent.width) || !Number.isInteger(extent.height) ||
    !Number.isInteger(extent.depthOrArrayLayers) || extent.width < 0 ||
    extent.height < 0 || extent.depthOrArrayLayers < 0
  ) throw new Error('Texture copy size must contain non-negative integer dimensions.');
  return extent;
}

function validateDataLayout(layout: GPUImageDataLayout): void {
  validateOptionalInteger(layout.offset, 'Texture data layout offset');
  validateOptionalInteger(layout.bytesPerRow, 'Texture data layout bytesPerRow');
  validateOptionalInteger(layout.rowsPerImage, 'Texture data layout rowsPerImage');
}

function lowerTextureDestination(
  destination: GPUImageCopyTexture,
  texture: WebGL2Texture,
  handle: object,
  size: Readonly<{ width: number; height: number; depthOrArrayLayers: number }>
): Readonly<Record<string, unknown>> {
  const mipLevel = destination.mipLevel ?? 0;
  const mipCount = texture.descriptor.mipLevelCount ?? 1;
  if (!Number.isInteger(mipLevel) || mipLevel < 0 || mipLevel >= mipCount) {
    throw new Error(`Texture mipLevel ${mipLevel} is outside texture "${texture.label ?? texture.id}" mipLevelCount ${mipCount}.`);
  }
  const origin = normalizeOrigin(destination.origin);
  const scale = 2 ** mipLevel;
  const bounds = {
    width: Math.max(1, Math.floor(texture.width / scale)),
    height: Math.max(1, Math.floor(texture.height / scale)),
    depthOrArrayLayers: texture.descriptor.dimension === '3d'
      ? Math.max(1, Math.floor(texture.depthOrArrayLayers / scale))
      : texture.depthOrArrayLayers
  };
  if (
    origin.x + size.width > bounds.width || origin.y + size.height > bounds.height ||
    origin.z + size.depthOrArrayLayers > bounds.depthOrArrayLayers
  ) {
    throw new Error(
      `Texture copy range exceeds texture "${texture.label ?? texture.id}" mip level ${mipLevel} bounds ` +
      `${bounds.width}x${bounds.height}x${bounds.depthOrArrayLayers}.`
    );
  }
  return Object.freeze({ texture: handle, mipLevel, origin: Object.freeze(origin), aspect: destination.aspect ?? 'all' });
}

function normalizeOrigin(origin: GPUImageCopyTexture['origin']) {
  const tuple = Array.isArray(origin) ? origin as readonly number[] : undefined;
  const object = tuple === undefined ? origin as { x?: number; y?: number; z?: number } | undefined : undefined;
  const value = tuple === undefined
    ? { x: object?.x ?? 0, y: object?.y ?? 0, z: object?.z ?? 0 }
    : { x: tuple[0] ?? 0, y: tuple[1] ?? 0, z: tuple[2] ?? 0 };
  if (!Number.isInteger(value.x) || !Number.isInteger(value.y) || !Number.isInteger(value.z) || value.x < 0 || value.y < 0 || value.z < 0) {
    throw new Error('Texture copy origin must contain non-negative integer coordinates.');
  }
  return value;
}

function validateOptionalInteger(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`${label} ${value} must be a non-negative integer.`);
  }
}

function pending<T>(operation: string): T {
  throw new Error(`WebGL2 backend operation ${operation} is not implemented yet.`);
}
