import type { BufferDescriptor, BufferRange } from '../types';
import type { BufferGraphRange } from './types';

export function fullBufferRange(descriptor: BufferDescriptor): BufferGraphRange {
  return normalizeBufferRange(descriptor);
}

export function normalizeBufferRange(
  descriptor: BufferDescriptor,
  range?: BufferRange
): BufferGraphRange {
  assertBufferDescriptor(descriptor);
  const normalized = range ?? { offset: 0, size: descriptor.size };
  assertBufferRange(normalized, descriptor);

  return Object.freeze({
    kind: 'buffer' as const,
    offset: normalized.offset,
    size: normalized.size,
    end: normalized.offset + normalized.size
  });
}

export function bufferGraphRange(offset: number, end: number): BufferGraphRange {
  return Object.freeze({ kind: 'buffer', offset, size: end - offset, end });
}

function assertBufferDescriptor(descriptor: BufferDescriptor): void {
  assertNonNegativeInteger(descriptor.size, 'Buffer descriptor size');
}

function assertBufferRange(range: BufferRange, descriptor: BufferDescriptor): void {
  assertNonNegativeInteger(range.offset, 'Buffer range offset');
  assertNonNegativeInteger(range.size, 'Buffer range size');
  if (range.offset + range.size > descriptor.size) {
    throw new Error('Buffer range is out of bounds.');
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer.`);
}
