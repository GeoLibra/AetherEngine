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

export interface PassBuilder {
  createTexture(descriptor: TextureDescriptor, options?: GraphResourceCreateOptions): TextureHandle;
  createBuffer(descriptor: BufferDescriptor, options?: GraphResourceCreateOptions): BufferHandle;
  readTexture(handle: TextureHandle, usage: TextureReadUsage, range?: TextureRange): TextureHandle;
  writeTexture(
    handle: TextureHandle,
    usage: TextureWriteUsage,
    range?: TextureRange
  ): TextureHandle;
  readBuffer(handle: BufferHandle, usage: BufferReadUsage, range?: BufferRange): BufferHandle;
  writeBuffer(handle: BufferHandle, usage: BufferWriteUsage, range?: BufferRange): BufferHandle;
  exportTexture(handle: TextureHandle, finalState: ExternalResourceState): void;
  exportBuffer(handle: BufferHandle, finalState: ExternalResourceState): void;
  presentTexture(handle: TextureHandle, surfaceFrame: SurfaceFrameToken): void;
  sideEffect(reason: string): void;
  after(pass: PassToken): void;
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

export class PassBuilderState implements PassBuilder {
  private readonly accesses: GraphAccess[] = [];
  private readonly terminals: GraphTerminal[] = [];
  private readonly sideEffects: string[] = [];
  private active = true;

  constructor(
    private readonly graph: RenderGraphPassContextDelegate,
    private readonly passId: number
  ) {}

  createTexture(
    descriptor: TextureDescriptor,
    options?: GraphResourceCreateOptions
  ): TextureHandle {
    this.assertActive();
    return this.graph.createTexture(descriptor, options);
  }

  createBuffer(descriptor: BufferDescriptor, options?: GraphResourceCreateOptions): BufferHandle {
    this.assertActive();
    return this.graph.createBuffer(descriptor, options);
  }

  readTexture(handle: TextureHandle, usage: TextureReadUsage, range?: TextureRange): TextureHandle {
    this.assertActive();
    this.accesses.push(this.graph.declareRead(this.passId, handle, usage, 'texture', range));
    return handle;
  }

  writeTexture(
    handle: TextureHandle,
    usage: TextureWriteUsage,
    range?: TextureRange
  ): TextureHandle {
    this.assertActive();
    const access = this.graph.declareWrite(this.passId, handle, usage, 'texture', range);
    this.accesses.push(access);
    return access.handle as TextureHandle;
  }

  readBuffer(handle: BufferHandle, usage: BufferReadUsage, range?: BufferRange): BufferHandle {
    this.assertActive();
    this.accesses.push(this.graph.declareRead(this.passId, handle, usage, 'buffer', range));
    return handle;
  }

  writeBuffer(handle: BufferHandle, usage: BufferWriteUsage, range?: BufferRange): BufferHandle {
    this.assertActive();
    const access = this.graph.declareWrite(this.passId, handle, usage, 'buffer', range);
    this.accesses.push(access);
    return access.handle as BufferHandle;
  }

  exportTexture(handle: TextureHandle, finalState: ExternalResourceState): void {
    this.export(handle, finalState, 'texture');
  }

  exportBuffer(handle: BufferHandle, finalState: ExternalResourceState): void {
    this.export(handle, finalState, 'buffer');
  }

  presentTexture(handle: TextureHandle, surfaceFrame: SurfaceFrameToken): void {
    this.assertActive();
    assertGraphHandle(handle, this.graph.graphId, 'texture');
    if (surfaceFrame.kind !== 'surface-frame' || !surfaceFrame.id) {
      throw new Error('Present terminal requires a valid surface frame token.');
    }
    this.graph.validatePresentBinding(handle, surfaceFrame);
    const terminal = Object.freeze({
      kind: 'present' as const,
      passId: this.passId,
      handle,
      surfaceFrame: Object.freeze({ ...surfaceFrame })
    });
    this.graph.declareTerminal(terminal);
    this.terminals.push(terminal);
  }

  sideEffect(reason: string): void {
    this.assertActive();
    if (!reason.trim()) throw new Error('Render graph side effects require a non-empty reason.');
    this.sideEffects.push(reason);
  }

  after(pass: PassToken): void {
    this.assertActive();
    this.graph.declareAfter(pass, this.passId);
  }

  complete(): void {
    this.active = false;
  }

  frozenAccesses(): readonly GraphAccess[] {
    return Object.freeze([...this.accesses]);
  }

  frozenTerminals(): readonly GraphTerminal[] {
    return Object.freeze([...this.terminals]);
  }

  frozenSideEffects(): readonly string[] {
    return Object.freeze([...this.sideEffects]);
  }

  private export(
    handle: GraphHandle,
    finalState: ExternalResourceState,
    expectedKind: GraphHandle['kind']
  ): void {
    this.assertActive();
    assertGraphHandle(handle, this.graph.graphId, expectedKind);
    this.graph.validateExportState(handle, finalState);
    const terminal = Object.freeze({
      kind: 'export' as const,
      passId: this.passId,
      handle,
      finalState
    });
    this.graph.declareTerminal(terminal);
    this.terminals.push(terminal);
  }

  private assertActive(): void {
    if (!this.active)
      throw new Error('Render graph pass setup is complete and its declaration is frozen.');
  }
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
