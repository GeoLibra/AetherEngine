import { assertGraphHandle } from './handles';
import type { GraphAccess, GraphTerminal } from './builder';
import type { RenderGraphPassContextDelegate, SurfaceFrameToken } from './pass-builder';
import type {
  BufferDescriptor,
  BufferHandle,
  BufferRange,
  BufferReadUsage,
  BufferWriteUsage,
  ColorAttachmentOptions,
  ComputePassBuilder,
  CopyPassBuilder,
  DeclaredColorAttachment,
  DeclaredDepthStencilAttachment,
  DeclaredResolveAttachment,
  DepthStencilAttachmentOptions,
  ExternalResourceState,
  GraphHandle,
  GraphResourceBuilder,
  GraphResourceCreateOptions,
  RasterPassBuilder,
  TextureDescriptor,
  TextureHandle,
  TextureRange,
  TextureReadUsage,
  TextureWriteUsage
} from '../types';
import type {
  PreparedComputePipelineToken,
  PreparedDrawResourcesToken,
  PreparedRenderPipelineToken
} from './prepared-resources';

export interface RasterPassDeclarationDetails {
  readonly colorAttachments: readonly DeclaredColorAttachment[];
  readonly depthStencilAttachment?: DeclaredDepthStencilAttachment | undefined;
  readonly resolveAttachments: readonly DeclaredResolveAttachment[];
  readonly preparedRenderPipelines: readonly PreparedRenderPipelineToken[];
  readonly preparedDrawResources: readonly PreparedDrawResourcesToken[];
}

export interface ComputePassDeclarationDetails {
  readonly preparedComputePipelines: readonly PreparedComputePipelineToken[];
}

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

  sideEffect(reason: string): void {
    this.assertActive();
    if (!reason.trim()) throw new Error('Render graph side effects require a non-empty reason.');
    this.sideEffects.push(reason);
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

export class RasterPassBuilderImpl extends BaseGraphResourceBuilder implements RasterPassBuilder {
  private readonly colorAttachmentsMap = new Map<number, DeclaredColorAttachment>();
  private depthStencilAttachmentDecl: DeclaredDepthStencilAttachment | undefined;
  private readonly resolveAttachmentsMap = new Map<number, DeclaredResolveAttachment>();
  private readonly renderPipelines = new Set<PreparedRenderPipelineToken>();
  private readonly drawResourcesTokens = new Set<PreparedDrawResourcesToken>();

  colorAttachment(
    slot: number,
    input: TextureHandle,
    options: ColorAttachmentOptions
  ): TextureHandle {
    this.assertActive();
    if (!Number.isInteger(slot) || slot < 0 || slot >= 8) {
      throw new Error(`Color attachment slot ${slot} must be an integer between 0 and 7.`);
    }
    if (this.colorAttachmentsMap.has(slot)) {
      throw new Error(`Color attachment slot ${slot} is already declared for this pass.`);
    }
    assertGraphHandle(input, this.graph.graphId, 'texture');
    const access = this.graph.declareWrite(
      this.passId,
      input,
      'color-attachment',
      'texture',
      options.range
    );
    this.accesses.push(access);
    const output = access.handle as TextureHandle;
    const attachment: DeclaredColorAttachment = Object.freeze({
      slot,
      input,
      output,
      options: Object.freeze({ ...options })
    });
    this.colorAttachmentsMap.set(slot, attachment);
    return output;
  }

  depthStencilAttachment(
    input: TextureHandle,
    options: DepthStencilAttachmentOptions
  ): TextureHandle {
    this.assertActive();
    if (this.depthStencilAttachmentDecl !== undefined) {
      throw new Error('Depth/stencil attachment is already declared for this pass.');
    }
    assertGraphHandle(input, this.graph.graphId, 'texture');
    const isReadOnly = options.depthAccess === 'read' && options.stencilAccess === 'read';
    let output: TextureHandle | undefined;
    if (isReadOnly) {
      const access = this.graph.declareRead(
        this.passId,
        input,
        'sampled',
        'texture',
        options.range
      );
      this.accesses.push(access);
      output = input;
    } else {
      const access = this.graph.declareWrite(
        this.passId,
        input,
        'depth-stencil-attachment',
        'texture',
        options.range
      );
      this.accesses.push(access);
      output = access.handle as TextureHandle;
    }
    this.depthStencilAttachmentDecl = Object.freeze({
      input,
      output: isReadOnly ? undefined : output,
      options: Object.freeze({ ...options })
    });
    return output;
  }

  resolveAttachment(
    slot: number,
    source: TextureHandle,
    destination: TextureHandle
  ): TextureHandle {
    this.assertActive();
    if (!Number.isInteger(slot) || slot < 0 || slot >= 8) {
      throw new Error(`Resolve attachment slot ${slot} must be an integer between 0 and 7.`);
    }
    if (this.resolveAttachmentsMap.has(slot)) {
      throw new Error(`Resolve attachment slot ${slot} is already declared for this pass.`);
    }
    assertGraphHandle(source, this.graph.graphId, 'texture');
    assertGraphHandle(destination, this.graph.graphId, 'texture');
    this.accesses.push(this.graph.declareRead(this.passId, source, 'sampled', 'texture'));
    const access = this.graph.declareWrite(this.passId, destination, 'color-attachment', 'texture');
    this.accesses.push(access);
    const output = access.handle as TextureHandle;
    this.resolveAttachmentsMap.set(slot, Object.freeze({ slot, source, destination, output }));
    return output;
  }

  useRenderPipeline(token: PreparedRenderPipelineToken): void {
    this.assertActive();
    this.renderPipelines.add(token);
  }

  useDrawResources(token: PreparedDrawResourcesToken): void {
    this.assertActive();
    this.drawResourcesTokens.add(token);
  }

  declarationDetails(): RasterPassDeclarationDetails {
    return Object.freeze({
      colorAttachments: Object.freeze([...this.colorAttachmentsMap.values()]),
      depthStencilAttachment: this.depthStencilAttachmentDecl,
      resolveAttachments: Object.freeze([...this.resolveAttachmentsMap.values()]),
      preparedRenderPipelines: Object.freeze([...this.renderPipelines]),
      preparedDrawResources: Object.freeze([...this.drawResourcesTokens])
    });
  }
}

export class ComputePassBuilderImpl extends BaseGraphResourceBuilder implements ComputePassBuilder {
  private readonly computePipelines = new Set<PreparedComputePipelineToken>();

  useComputePipeline(token: PreparedComputePipelineToken): void {
    this.assertActive();
    this.computePipelines.add(token);
  }

  declarationDetails(): ComputePassDeclarationDetails {
    return Object.freeze({
      preparedComputePipelines: Object.freeze([...this.computePipelines])
    });
  }
}

export class CopyPassBuilderImpl extends BaseGraphResourceBuilder implements CopyPassBuilder {}
