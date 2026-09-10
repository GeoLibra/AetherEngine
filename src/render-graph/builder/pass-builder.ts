import { assertGraphHandle, isGraphHandle } from './handles';
import type { GraphResourceCreateOptions } from './resources';
import type { GraphAccess, GraphTerminal } from './builder';
import type { GraphRange } from '../compiler/ranges';
import type {
  BufferDescriptor,
  BufferHandle,
  BufferRange,
  BufferReadUsage,
  BufferWriteUsage,
  ExternalResourceState,
  GraphHandle,
  PassToken,
  TextureDescriptor,
  TextureHandle,
  TextureRange,
  TextureReadUsage,
  TextureWriteUsage
} from '../types';

export interface SurfaceFrameToken {
  readonly kind: 'surface-frame';
  readonly id: string;
}

export interface RenderGraphPassContextDelegate {
  readonly graphId: number;
  createTexture(descriptor: TextureDescriptor, options?: GraphResourceCreateOptions): TextureHandle;
  createBuffer(descriptor: BufferDescriptor, options?: GraphResourceCreateOptions): BufferHandle;
  descriptorFor(handle: GraphHandle): TextureDescriptor | BufferDescriptor;
  normalizeRange(handle: GraphHandle, range?: TextureRange | BufferRange): GraphRange;
  declareRead(
    passId: number,
    handle: GraphHandle,
    usage: TextureReadUsage | BufferReadUsage,
    expectedKind: GraphHandle['kind'],
    range?: TextureRange | BufferRange
  ): GraphAccess;
  declareWrite(
    passId: number,
    handle: GraphHandle,
    usage: TextureWriteUsage | BufferWriteUsage,
    expectedKind: GraphHandle['kind'],
    range?: TextureRange | BufferRange
  ): GraphAccess;
  declareTerminal(terminal: GraphTerminal): void;
  declareAfter(fromPass: PassToken, toPassId: number): void;
  validatePresentBinding(handle: TextureHandle, surfaceFrame: SurfaceFrameToken): void;
  validateExportState(handle: GraphHandle, finalState: ExternalResourceState): void;
}

export function validatePassDescriptor<TResources, TContext>(descriptor: {
  readonly id: string;
  setup: unknown;
  run: unknown;
}): void {
  if (!descriptor.id.trim()) throw new Error('Render graph pass id must be non-empty.');
  if (typeof descriptor.setup !== 'function' || typeof descriptor.run !== 'function') {
    throw new Error('Render graph passes require setup and run callbacks.');
  }
}

export { isPromiseLike } from '../../core';

export function snapshotSetupValue<T>(
  value: T,
  visiting = new WeakSet<object>(),
  completed = new WeakMap<object, unknown>()
): T {
  if (typeof value === 'function') {
    throw new Error('Render graph setup resources cannot contain mutable function values.');
  }
  if (typeof value !== 'object' || value === null) return value;
  if (isGraphHandle(value)) return value as T;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    const name = prototype?.constructor?.name ?? 'unknown';
    throw new Error(`Render graph setup resources cannot contain mutable container ${name}.`);
  }
  const existing = completed.get(value);
  if (existing !== undefined) return existing as T;
  if (visiting.has(value)) throw new Error('Render graph setup resources must not contain cycles.');
  visiting.add(value);
  const snapshot = Array.isArray(value) ? new Array(value.length) : Object.create(prototype);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property?.get !== undefined || property?.set !== undefined) {
      throw new Error('Render graph setup resources must contain data properties only.');
    }
    if (property !== undefined && 'value' in property) {
      Object.defineProperty(snapshot, key, {
        ...property,
        value: snapshotSetupValue(property.value, visiting, completed)
      });
    }
  }
  visiting.delete(value);
  const frozen = Object.freeze(snapshot);
  completed.set(value, frozen);
  return frozen as T;
}
