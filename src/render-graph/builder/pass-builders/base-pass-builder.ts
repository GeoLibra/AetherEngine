import { assertGraphHandle } from '../handles';
import type {
  BufferDescriptor,
  BufferHandle,
  BufferRange,
  BufferReadUsage,
  BufferWriteUsage,
  ExternalResourceState,
  GraphAccess,
  GraphHandle,
  GraphResourceBuilder,
  GraphResourceCreateOptions,
  GraphTerminal,
  PassToken,
  RenderGraphPassContextDelegate,
  SurfaceFrameToken,
  TextureDescriptor,
  TextureHandle,
  TextureRange,
  TextureReadUsage,
  TextureWriteUsage
} from '../../types';

/**
 * Base implementation of GraphResourceBuilder providing shared read/write declarations,
 * semantic sequencing, side-effect recording, and terminal output registration.
 */
export class BaseGraphResourceBuilder implements GraphResourceBuilder {
  protected readonly accesses: GraphAccess[] = [];
  protected readonly terminals: GraphTerminal[] = [];
  protected readonly sideEffects: string[] = [];
  protected active = true;

  constructor(
    protected readonly graph: RenderGraphPassContextDelegate,
    protected readonly passId: number
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

  readBuffer(handle: BufferHandle, usage: BufferReadUsage, range?: BufferRange): BufferHandle {
    this.assertActive();
    this.accesses.push(this.graph.declareRead(this.passId, handle, usage, 'buffer', range));
    return handle;
  }

  protected declareWriteTexture(
    handle: TextureHandle,
    usage: TextureWriteUsage,
    range?: TextureRange
  ): TextureHandle {
    this.assertActive();
    const access = this.graph.declareWrite(this.passId, handle, usage, 'texture', range);
    this.accesses.push(access);
    return access.handle as TextureHandle;
  }

  protected declareWriteBuffer(
    handle: BufferHandle,
    usage: BufferWriteUsage,
    range?: BufferRange
  ): BufferHandle {
    this.assertActive();
    const access = this.graph.declareWrite(this.passId, handle, usage, 'buffer', range);
    this.accesses.push(access);
    return access.handle as BufferHandle;
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

  exportResource(handle: GraphHandle, finalState: ExternalResourceState): void {
    this.assertActive();
    assertGraphHandle(handle, this.graph.graphId);
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

  present(handle: TextureHandle, surfaceFrame: SurfaceFrameToken): void {
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

  protected assertActive(): void {
    if (!this.active) {
      throw new Error('Render graph pass setup is complete and its declaration is frozen.');
    }
  }
}
