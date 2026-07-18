import {
  ResourceVersionStore,
  type GraphResourceCreateOptions,
  type GraphResourceRecord
} from './resources';
import type { GraphRange } from './ranges';
import {
  assertGraphHandle,
  type BufferDescriptor,
  type BufferHandle,
  type BufferRange,
  type BufferReadUsage,
  type BufferWriteUsage,
  type ExternalResourceState,
  type GraphHandle,
  type PassToken,
  type TextureDescriptor,
  type TextureHandle,
  type TextureRange,
  type TextureReadUsage,
  type TextureWriteUsage
} from './types';

export interface SurfaceFrameToken {
  readonly kind: 'surface-frame';
  readonly id: string;
}

export interface GraphReadAccess {
  readonly kind: 'read';
  readonly passId: number;
  readonly handle: GraphHandle;
  readonly usage: TextureReadUsage | BufferReadUsage;
  readonly range: GraphRange;
}

export interface GraphWriteAccess {
  readonly kind: 'write';
  readonly passId: number;
  readonly source: GraphHandle;
  readonly handle: GraphHandle;
  readonly usage: TextureWriteUsage | BufferWriteUsage;
  readonly range: GraphRange;
}

export type GraphAccess = GraphReadAccess | GraphWriteAccess;

export type GraphTerminal =
  | {
      readonly kind: 'export';
      readonly passId: number;
      readonly handle: GraphHandle;
      readonly finalState: ExternalResourceState;
    }
  | {
      readonly kind: 'present';
      readonly passId: number;
      readonly handle: TextureHandle;
      readonly surfaceFrame: SurfaceFrameToken;
    };

export interface SemanticEdge {
  readonly kind: 'after';
  readonly fromPassId: number;
  readonly toPassId: number;
}

export interface GraphPassDescriptor<TResources, TContext = unknown> {
  readonly id: string;
  setup(pass: PassBuilder): TResources;
  run(context: TContext, resources: TResources): void;
}

export interface GraphPassDeclaration {
  readonly id: string;
  readonly token: PassToken;
  readonly registrationIndex: number;
  readonly accesses: readonly GraphAccess[];
  readonly terminals: readonly GraphTerminal[];
  readonly sideEffects: readonly string[];
  readonly resources: unknown;
  readonly run: (context: unknown) => void;
}

export interface RenderGraphSnapshot {
  readonly graphId: number;
  readonly resources: readonly GraphResourceRecord[];
  readonly passes: readonly GraphPassDeclaration[];
  readonly terminals: readonly GraphTerminal[];
  readonly semanticEdges: readonly SemanticEdge[];
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

let nextGraphId = 1;
const TEXTURE_READ_USAGES = new Set<string>(['sampled', 'copy-src', 'storage-read']);
const TEXTURE_WRITE_USAGES = new Set<string>([
  'color-attachment',
  'depth-stencil-attachment',
  'copy-dst',
  'storage-write'
]);
const BUFFER_READ_USAGES = new Set<string>([
  'uniform',
  'vertex',
  'index',
  'indirect',
  'copy-src',
  'storage-read'
]);
const BUFFER_WRITE_USAGES = new Set<string>(['copy-dst', 'storage-write', 'query-resolve']);

export class RenderGraphBuilder {
  readonly graphId = nextGraphId++;
  private readonly resources = new ResourceVersionStore(this.graphId);
  private readonly passes: GraphPassDeclaration[] = [];
  private readonly passTokens = new Map<number, PassToken>();
  private readonly passNames = new Set<string>();
  private readonly terminals: GraphTerminal[] = [];
  private readonly terminalResourceIds = new Set<number>();
  private readonly semanticEdges: SemanticEdge[] = [];
  private phase: 'authoring' | 'building' | 'built' = 'authoring';

  createTexture(
    descriptor: TextureDescriptor,
    options?: GraphResourceCreateOptions
  ): TextureHandle {
    this.assertAuthoring();
    return this.resources.createTexture(descriptor, options);
  }

  createBuffer(descriptor: BufferDescriptor, options?: GraphResourceCreateOptions): BufferHandle {
    this.assertAuthoring();
    return this.resources.createBuffer(descriptor, options);
  }

  addPass<TResources, TContext = unknown>(
    descriptor: GraphPassDescriptor<TResources, TContext>
  ): PassToken {
    this.assertAuthoring();
    validatePassDescriptor(descriptor);
    if (this.passNames.has(descriptor.id)) {
      throw new Error(`Render graph pass id "${descriptor.id}" is already registered.`);
    }

    const passId = this.passes.length;
    const token = Object.freeze({ kind: 'pass' as const, graphId: this.graphId, passId });
    const passBuilder = new PassBuilderState(this, passId);
    const resourceCheckpoint = this.resources.checkpoint();
    const terminalCheckpoint = [...this.terminals];
    const semanticEdgeCount = this.semanticEdges.length;
    let setupResources: TResources;
    let frozenResources: TResources;
    try {
      setupResources = descriptor.setup(passBuilder);
      if (isPromiseLike(setupResources)) {
        throw new Error('Render graph pass setup must be synchronous and purely declarative.');
      }
      frozenResources = freezeSetupValue(setupResources);
    } catch (error) {
      this.resources.rollback(resourceCheckpoint);
      this.terminals.splice(0, this.terminals.length, ...terminalCheckpoint);
      this.semanticEdges.length = semanticEdgeCount;
      this.rebuildTerminalResourceIds();
      throw error;
    } finally {
      passBuilder.complete();
    }

    const declaration = Object.freeze({
      id: descriptor.id,
      token,
      registrationIndex: passId,
      accesses: passBuilder.frozenAccesses(),
      terminals: passBuilder.frozenTerminals(),
      sideEffects: passBuilder.frozenSideEffects(),
      resources: frozenResources,
      run: (context: unknown) => descriptor.run(context as TContext, frozenResources as TResources)
    });
    this.passes.push(declaration);
    this.passTokens.set(passId, token);
    this.passNames.add(descriptor.id);
    return token;
  }

  build(): RenderGraphSnapshot {
    this.assertAuthoring();
    this.phase = 'building';
    for (const terminal of this.terminals) {
      if (terminal.handle.version !== this.resources.currentVersion(terminal.handle)) {
        throw new Error(
          `Render graph terminal must reference the final logical content version of resource ${terminal.handle.resourceId}.`
        );
      }
    }

    const snapshot = Object.freeze({
      graphId: this.graphId,
      resources: this.resources.snapshot(),
      passes: Object.freeze([...this.passes]),
      terminals: Object.freeze([...this.terminals]),
      semanticEdges: Object.freeze([...this.semanticEdges])
    });
    this.phase = 'built';
    return snapshot;
  }

  /** @internal PassBuilderState is the only mutation path during setup. */
  declareRead(
    passId: number,
    handle: GraphHandle,
    usage: TextureReadUsage | BufferReadUsage,
    expectedKind: GraphHandle['kind'],
    range?: TextureRange | BufferRange
  ): GraphReadAccess {
    this.assertAuthoring();
    assertGraphHandle(handle, this.graphId, expectedKind);
    assertAccessUsage(expectedKind, 'read', usage);
    this.assertDescriptorUsage(handle, usage);
    const normalized = this.resources.normalizeRange(handle, range);
    this.resources.assertInitialized(handle, normalized);
    return Object.freeze({ kind: 'read', passId, handle, usage, range: normalized });
  }

  /** @internal PassBuilderState is the only mutation path during setup. */
  declareWrite(
    passId: number,
    handle: GraphHandle,
    usage: TextureWriteUsage | BufferWriteUsage,
    expectedKind: GraphHandle['kind'],
    range?: TextureRange | BufferRange
  ): GraphWriteAccess {
    this.assertAuthoring();
    assertGraphHandle(handle, this.graphId, expectedKind);
    assertAccessUsage(expectedKind, 'write', usage);
    this.assertDescriptorUsage(handle, usage);
    const normalized = this.resources.normalizeRange(handle, range);
    const output = this.resources.write(handle, passId, normalized);
    return Object.freeze({
      kind: 'write',
      passId,
      source: handle,
      handle: output,
      usage,
      range: normalized
    });
  }

  /** @internal */
  declareTerminal(terminal: GraphTerminal): void {
    this.assertAuthoring();
    assertGraphHandle(terminal.handle, this.graphId, terminal.handle.kind);
    this.resources.assertInitialized(
      terminal.handle,
      this.resources.normalizeRange(terminal.handle)
    );
    const existingIndex = this.terminals.findIndex(
      (existing) => existing.handle.resourceId === terminal.handle.resourceId
    );
    if (existingIndex >= 0) {
      const existing = this.terminals[existingIndex] as GraphTerminal;
      if (terminal.handle.version <= existing.handle.version) {
        throw new Error(
          `Render graph resource ${terminal.handle.resourceId} already has a terminal operation for this version.`
        );
      }
      this.terminals[existingIndex] = terminal;
      return;
    }
    if (this.terminalResourceIds.has(terminal.handle.resourceId)) {
      throw new Error(
        `Render graph resource ${terminal.handle.resourceId} already has a terminal operation.`
      );
    }
    this.terminalResourceIds.add(terminal.handle.resourceId);
    this.terminals.push(terminal);
  }

  /** @internal */
  declareAfter(from: PassToken, toPassId: number): SemanticEdge {
    this.assertAuthoring();
    if (from.graphId !== this.graphId || this.passTokens.get(from.passId) !== from) {
      throw new Error('Semantic edge references a foreign or unknown render graph pass.');
    }
    if (from.passId === toPassId)
      throw new Error('A render graph pass cannot be ordered after itself.');
    const edge = Object.freeze({ kind: 'after' as const, fromPassId: from.passId, toPassId });
    if (
      this.semanticEdges.some(
        (existing) => existing.fromPassId === edge.fromPassId && existing.toPassId === edge.toPassId
      )
    ) {
      throw new Error('Duplicate render graph semantic edge.');
    }
    this.semanticEdges.push(edge);
    return edge;
  }

  private assertDescriptorUsage(handle: GraphHandle, usage: string): void {
    const descriptor = this.resources.descriptorFor(handle);
    if (!(descriptor.usage as readonly string[]).includes(usage)) {
      throw new Error(`Render graph ${handle.kind} descriptor does not declare usage "${usage}".`);
    }
  }

  private rebuildTerminalResourceIds(): void {
    this.terminalResourceIds.clear();
    for (const terminal of this.terminals) {
      this.terminalResourceIds.add(terminal.handle.resourceId);
    }
  }

  private assertAuthoring(): void {
    if (this.phase !== 'authoring') {
      throw new Error('Render graph declarations cannot be mutated after build() begins.');
    }
  }
}

class PassBuilderState implements PassBuilder {
  private readonly accesses: GraphAccess[] = [];
  private readonly terminals: GraphTerminal[] = [];
  private readonly sideEffects: string[] = [];
  private readonly afterEdges: SemanticEdge[] = [];
  private active = true;

  constructor(
    private readonly graph: RenderGraphBuilder,
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
    this.afterEdges.push(this.graph.declareAfter(pass, this.passId));
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

function validatePassDescriptor<TResources, TContext>(
  descriptor: GraphPassDescriptor<TResources, TContext>
): void {
  if (!descriptor.id.trim()) throw new Error('Render graph pass id must be non-empty.');
  if (typeof descriptor.setup !== 'function' || typeof descriptor.run !== 'function') {
    throw new Error('Render graph passes require setup and run callbacks.');
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value;
}

function freezeSetupValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  if (seen.has(value)) throw new Error('Render graph setup resources must not contain cycles.');
  seen.add(value);
  for (const child of Object.values(value)) freezeSetupValue(child, seen);
  return Object.freeze(value);
}

function assertAccessUsage(kind: GraphHandle['kind'], mode: 'read' | 'write', usage: string): void {
  const allowed =
    kind === 'texture'
      ? mode === 'read'
        ? TEXTURE_READ_USAGES
        : TEXTURE_WRITE_USAGES
      : mode === 'read'
        ? BUFFER_READ_USAGES
        : BUFFER_WRITE_USAGES;
  if (!allowed.has(usage)) {
    throw new Error(`Render graph ${kind} ${mode} usage "${usage}" is invalid.`);
  }
}
