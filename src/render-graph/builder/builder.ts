import {
  ResourceVersionStore,
  type GraphResourceCreateOptions,
  type GraphResourceRecord
} from './resources';
import type { GraphRange } from '../compiler/ranges';
import { assertGraphHandle } from './handles';
import {
  snapshotSetupValue,
  validatePassDescriptor,
  isPromiseLike,
  type RenderGraphPassContextDelegate,
  type SurfaceFrameToken
} from './pass-builder';
import type {
  BufferDescriptor,
  BufferHandle,
  BufferRange,
  BufferReadUsage,
  BufferWriteUsage,
  ComputePassDescriptor,
  CopyPassDescriptor,
  ExternalResourceState,
  GraphHandle,
  PassKind,
  PassToken,
  RasterPassDescriptor,
  TextureDescriptor,
  TextureHandle,
  TextureRange,
  TextureReadUsage,
  TextureWriteUsage
} from '../types';
import {
  ComputePassBuilderImpl,
  CopyPassBuilderImpl,
  RasterPassBuilderImpl,
  type ComputePassDeclarationDetails,
  type RasterPassDeclarationDetails
} from './typed-pass-builder';

export type { SurfaceFrameToken } from './pass-builder';
export type {
  RasterPassDeclarationDetails,
  ComputePassDeclarationDetails
} from './typed-pass-builder';

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

export interface GraphPassDeclaration {
  readonly id: string;
  readonly token: PassToken;
  readonly registrationIndex: number;
  readonly passKind: PassKind;
  readonly accesses: readonly GraphAccess[];
  readonly terminals: readonly GraphTerminal[];
  readonly sideEffects: readonly string[];
  readonly rasterDetails?: RasterPassDeclarationDetails;
  readonly computeDetails?: ComputePassDeclarationDetails;
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

let nextGraphId = 1;
const TEXTURE_READ_USAGES = new Set('sampled copy-src storage-read'.split(' '));
const TEXTURE_WRITE_USAGES = new Set(
  'color-attachment depth-stencil-attachment copy-dst storage-write'.split(' ')
);
const BUFFER_READ_USAGES = new Set(
  'uniform vertex index indirect copy-src storage-read'.split(' ')
);
const BUFFER_WRITE_USAGES = new Set('copy-dst storage-write query-resolve'.split(' '));

export class RenderGraphBuilder implements RenderGraphPassContextDelegate {
  readonly graphId = nextGraphId++;
  private readonly resources = new ResourceVersionStore(this.graphId);
  private readonly passes: GraphPassDeclaration[] = [];
  private readonly passTokens = new Map<number, PassToken>();
  private readonly passNamesById = new Map<number, string>();
  private readonly definedPassIds = new Set<number>();
  private readonly passNames = new Set<string>();
  private readonly terminals: GraphTerminal[] = [];
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

  descriptorFor(handle: GraphHandle): TextureDescriptor | BufferDescriptor {
    assertGraphHandle(handle, this.graphId, handle.kind);
    return this.resources.descriptorFor(handle);
  }

  normalizeRange(handle: GraphHandle, range?: TextureRange | BufferRange): GraphRange {
    assertGraphHandle(handle, this.graphId, handle.kind);
    return this.resources.normalizeRange(handle, range);
  }

  addRasterPass<TResources>(descriptor: RasterPassDescriptor<TResources>): PassToken {
    const token = this.reservePass(descriptor.id);
    try {
      return this.defineRasterPass(token, descriptor);
    } catch (error) {
      this.cancelReservation(token, descriptor.id);
      throw error;
    }
  }

  addComputePass<TResources>(descriptor: ComputePassDescriptor<TResources>): PassToken {
    const token = this.reservePass(descriptor.id);
    try {
      return this.defineComputePass(token, descriptor);
    } catch (error) {
      this.cancelReservation(token, descriptor.id);
      throw error;
    }
  }

  addCopyPass<TResources>(descriptor: CopyPassDescriptor<TResources>): PassToken {
    const token = this.reservePass(descriptor.id);
    try {
      return this.defineCopyPass(token, descriptor);
    } catch (error) {
      this.cancelReservation(token, descriptor.id);
      throw error;
    }
  }

  /** Reserves stable registration identity so forward semantic edges need no authoring scheduler. */
  reservePass(id: string): PassToken {
    this.assertAuthoring();
    if (!id.trim()) throw new Error('Render graph pass id must be non-empty.');
    if (this.passNames.has(id)) {
      throw new Error(`Render graph pass id "${id}" is already registered.`);
    }
    const passId = this.passTokens.size;
    const token = Object.freeze({ kind: 'pass' as const, graphId: this.graphId, passId });
    this.passTokens.set(passId, token);
    this.passNamesById.set(passId, id);
    this.passNames.add(id);
    return token;
  }

  /** Defines one previously reserved node; compilation remains the only topology authority. */
  defineRasterPass<TResources>(
    token: PassToken,
    descriptor: RasterPassDescriptor<TResources>
  ): PassToken {
    return this.defineGenericPass<RasterPassBuilderImpl, TResources>(
      token,
      descriptor,
      (passId) => new RasterPassBuilderImpl(this, passId),
      'raster',
      (b) => ({ rasterDetails: b.declarationDetails() })
    );
  }

  defineComputePass<TResources>(
    token: PassToken,
    descriptor: ComputePassDescriptor<TResources>
  ): PassToken {
    return this.defineGenericPass<ComputePassBuilderImpl, TResources>(
      token,
      descriptor,
      (passId) => new ComputePassBuilderImpl(this, passId),
      'compute',
      (b) => ({ computeDetails: b.declarationDetails() })
    );
  }

  defineCopyPass<TResources>(
    token: PassToken,
    descriptor: CopyPassDescriptor<TResources>
  ): PassToken {
    return this.defineGenericPass<CopyPassBuilderImpl, TResources>(
      token,
      descriptor,
      (passId) => new CopyPassBuilderImpl(this, passId),
      'copy'
    );
  }

  private defineGenericPass<
    TBuilder extends {
      complete(): void;
      frozenAccesses(): readonly GraphAccess[];
      frozenTerminals(): readonly GraphTerminal[];
      frozenSideEffects(): readonly string[];
    },
    TResources
  >(
    token: PassToken,
    descriptor: { readonly id: string; setup: (builder: any) => TResources; run: unknown },
    createBuilder: (passId: number) => TBuilder,
    passKind: PassKind,
    getDetails?: (builder: TBuilder) => {
      rasterDetails?: RasterPassDeclarationDetails;
      computeDetails?: ComputePassDeclarationDetails;
    }
  ): PassToken {
    this.assertAuthoring();
    validatePassDescriptor(descriptor as any);
    if (token.graphId !== this.graphId || this.passTokens.get(token.passId) !== token) {
      throw new Error('Render graph pass definition references a foreign or unknown reservation.');
    }
    if (this.passNamesById.get(token.passId) !== descriptor.id) {
      throw new Error('Render graph pass definition id does not match its reservation.');
    }
    if (this.definedPassIds.has(token.passId)) {
      throw new Error(`Render graph pass id "${descriptor.id}" is already defined.`);
    }
    const run = descriptor.run as (context: unknown, resources: unknown) => void;
    const passId = token.passId;
    const passBuilder = createBuilder(passId);
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
      frozenResources = snapshotSetupValue(setupResources);
    } catch (error) {
      this.resources.rollback(resourceCheckpoint);
      this.terminals.splice(0, this.terminals.length, ...terminalCheckpoint);
      this.semanticEdges.length = semanticEdgeCount;
      throw error;
    } finally {
      passBuilder.complete();
    }

    const details = getDetails?.(passBuilder);
    const declaration = Object.freeze({
      id: descriptor.id,
      token,
      registrationIndex: passId,
      passKind,
      accesses: passBuilder.frozenAccesses(),
      terminals: passBuilder.frozenTerminals(),
      sideEffects: passBuilder.frozenSideEffects(),
      ...(details?.rasterDetails ? { rasterDetails: details.rasterDetails } : {}),
      ...(details?.computeDetails ? { computeDetails: details.computeDetails } : {}),
      resources: frozenResources,
      run: (context: unknown) => run(context, frozenResources)
    });
    validatePassAccessUsages(declaration);
    this.passes.push(declaration);
    this.definedPassIds.add(passId);
    return token;
  }

  private cancelReservation(token: PassToken, id: string): void {
    this.passTokens.delete(token.passId);
    this.passNamesById.delete(token.passId);
    this.passNames.delete(id);
  }

  build(): RenderGraphSnapshot {
    this.assertAuthoring();
    if (this.definedPassIds.size !== this.passTokens.size) {
      throw new Error('Every reserved render graph pass must be defined before build().');
    }
    this.phase = 'building';
    for (const pass of this.passes) {
      validatePassAccessUsages(pass);
    }
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
    this.terminals.push(terminal);
  }

  validateExportState(handle: GraphHandle, finalState: ExternalResourceState): void {
    if (
      finalState === 'undefined' ||
      (!readUsages(handle.kind).has(finalState) && !writeUsages(handle.kind).has(finalState))
    ) {
      throw new Error(
        `Render graph export state "${finalState}" is invalid for ${handle.kind} resources.`
      );
    }
    this.assertDescriptorUsage(handle, finalState);
  }

  validatePresentBinding(handle: TextureHandle, surfaceFrame: SurfaceFrameToken): void {
    const origin = this.resources.originFor(handle);
    if (origin.kind !== 'imported') {
      throw new Error('Render graph present requires an imported surface texture.');
    }
    if (origin.acquire.id !== surfaceFrame.id) {
      throw new Error(
        'Render graph present frame token does not match the imported acquire token.'
      );
    }
  }

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

  private assertAuthoring(): void {
    if (this.phase !== 'authoring') {
      throw new Error('Render graph declarations cannot be mutated after build() begins.');
    }
  }
}

function assertAccessUsage(kind: GraphHandle['kind'], mode: 'read' | 'write', usage: string): void {
  const allowed = mode === 'read' ? readUsages(kind) : writeUsages(kind);
  if (!allowed.has(usage)) {
    throw new Error(`Render graph ${kind} ${mode} usage "${usage}" is invalid.`);
  }
}

function readUsages(kind: GraphHandle['kind']): ReadonlySet<string> {
  return kind === 'texture' ? TEXTURE_READ_USAGES : BUFFER_READ_USAGES;
}

function writeUsages(kind: GraphHandle['kind']): ReadonlySet<string> {
  return kind === 'texture' ? TEXTURE_WRITE_USAGES : BUFFER_WRITE_USAGES;
}

/**
 * Validates passKind × access usage rules defensively to prevent bypassing via type assertion.
 *
 * - Raster attachment writes must only occur through declared attachments (colorAttachment, depthStencilAttachment, resolveAttachment).
 * - Compute writes must only declare storage-write.
 * - Copy writes must only declare copy-dst.
 */
export function validatePassAccessUsages(pass: GraphPassDeclaration): void {
  for (const access of pass.accesses) {
    if (access.kind === 'write') {
      switch (pass.passKind) {
        case 'raster': {
          if (access.handle.kind !== 'texture') {
            throw new Error(
              `Raster pass "${pass.id}" cannot declare buffer write access. Only texture attachment writes are allowed.`
            );
          }
          if (access.usage !== 'color-attachment' && access.usage !== 'depth-stencil-attachment') {
            throw new Error(
              `Raster pass "${pass.id}" cannot declare write usage "${access.usage}". Only attachment writes are allowed.`
            );
          }
          const details = pass.rasterDetails;
          const isColorAttachment = details?.colorAttachments.some(
            (att) =>
              att.output.resourceId === access.handle.resourceId &&
              att.output.version === access.handle.version
          );
          const isDepthAttachment =
            details?.depthStencilAttachment?.output !== undefined &&
            details.depthStencilAttachment.output.resourceId === access.handle.resourceId &&
            details.depthStencilAttachment.output.version === access.handle.version;
          const isResolveAttachment = details?.resolveAttachments.some(
            (att) =>
              att.output.resourceId === access.handle.resourceId &&
              att.output.version === access.handle.version
          );
          if (!isColorAttachment && !isDepthAttachment && !isResolveAttachment) {
            throw new Error(
              `Raster pass "${pass.id}" texture write must be declared through colorAttachment, depthStencilAttachment, or resolveAttachment.`
            );
          }
          break;
        }
        case 'compute': {
          if (access.usage !== 'storage-write') {
            throw new Error(
              `Compute pass "${pass.id}" cannot declare write usage "${access.usage}". Only "storage-write" is allowed.`
            );
          }
          break;
        }
        case 'copy': {
          if (access.usage !== 'copy-dst') {
            throw new Error(
              `Copy pass "${pass.id}" cannot declare write usage "${access.usage}". Only "copy-dst" is allowed.`
            );
          }
          break;
        }
        default: {
          const exhaustiveCheck: never = pass.passKind;
          throw new Error(`Unsupported pass kind: ${(exhaustiveCheck as any)?.passKind}`);
        }
      }
    }
  }
}
