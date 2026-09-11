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
  ComputeBufferWriteUsage,
  ComputePassBuilder,
  ComputeTextureWriteUsage,
  CopyBufferWriteUsage,
  CopyPassBuilder,
  CopyTextureWriteUsage,
  DeclaredColorAttachment,
  DeclaredDepthStencilAttachment,
  DeclaredResolveAttachment,
  DepthStencilAttachmentOptions,
  ExternalResourceState,
  GraphHandle,
  GraphResourceBuilder,
  GraphResourceCreateOptions,
  PassToken,
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
    const color = this.colorAttachmentsMap.get(slot);
    if (color === undefined || color.output !== source) {
      throw new Error(
        `Resolve attachment slot ${slot} source must be the output returned by colorAttachment(${slot}, ...).`
      );
    }
    if (source.resourceId === destination.resourceId) {
      throw new Error('Resolve source and destination must be distinct texture resources.');
    }
    const sourceDescriptor = this.graph.descriptorFor(source) as TextureDescriptor;
    const destinationDescriptor = this.graph.descriptorFor(destination) as TextureDescriptor;
    if (sourceDescriptor.sampleCount <= 1 || destinationDescriptor.sampleCount !== 1) {
      throw new Error('Resolve requires a multisampled source and a single-sampled destination.');
    }
    if (sourceDescriptor.format !== destinationDescriptor.format) {
      throw new Error('Resolve source and destination formats must match.');
    }
    const sourceRange = this.graph.normalizeRange(source, color.options.range) as TextureRange;
    const destinationRange = this.graph.normalizeRange(destination) as TextureRange;
    const sourceWidth = Math.max(1, sourceDescriptor.width >> sourceRange.baseMipLevel);
    const sourceHeight = Math.max(1, sourceDescriptor.height >> sourceRange.baseMipLevel);
    const destinationWidth = Math.max(
      1,
      destinationDescriptor.width >> destinationRange.baseMipLevel
    );
    const destinationHeight = Math.max(
      1,
      destinationDescriptor.height >> destinationRange.baseMipLevel
    );
    if (
      sourceRange.mipLevelCount !== 1 ||
      destinationRange.mipLevelCount !== 1 ||
      sourceRange.arrayLayerCount !== destinationRange.arrayLayerCount ||
      sourceWidth !== destinationWidth ||
      sourceHeight !== destinationHeight
    ) {
      throw new Error('Resolve source and destination subresource extents must match.');
    }
    const access = this.graph.declareWrite(
      this.passId,
      destination,
      'color-attachment',
      'texture',
      destinationRange
    );
    this.accesses.push(access);
    const output = access.handle as TextureHandle;
    this.resolveAttachmentsMap.set(
      slot,
      Object.freeze({ slot, source, destination, output, sourceRange, destinationRange })
    );
    return output;
  }

  writeBuffer(): never {
    throw new Error(
      `Raster pass "${this.passId}" cannot declare buffer write access. Only texture attachment writes are allowed.`
    );
  }

  writeTexture(_handle: TextureHandle, usage: string): never {
    throw new Error(
      `Raster pass "${this.passId}" cannot declare texture write usage "${usage}". Only attachment writes are allowed.`
    );
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
    const colorAttachments = [...this.colorAttachmentsMap.values()].sort(
      (first, second) => first.slot - second.slot
    );
    colorAttachments.forEach((attachment, index) => {
      if (attachment.slot !== index) {
        throw new Error('Raster color attachment slots must be contiguous and start at slot 0.');
      }
    });
    return Object.freeze({
      colorAttachments: Object.freeze(colorAttachments),
      depthStencilAttachment: this.depthStencilAttachmentDecl,
      resolveAttachments: Object.freeze([...this.resolveAttachmentsMap.values()]),
      preparedRenderPipelines: Object.freeze([...this.renderPipelines]),
      preparedDrawResources: Object.freeze([...this.drawResourcesTokens])
    });
  }
}

export class ComputePassBuilderImpl extends BaseGraphResourceBuilder implements ComputePassBuilder {
  private readonly computePipelines = new Set<PreparedComputePipelineToken>();

  writeTexture(
    handle: TextureHandle,
    usage: ComputeTextureWriteUsage,
    range?: TextureRange
  ): TextureHandle {
    if (usage !== 'storage-write') {
      throw new Error(
        `Compute pass cannot declare texture write usage "${usage}". Only "storage-write" is allowed.`
      );
    }
    return this.declareWriteTexture(handle, usage, range);
  }

  writeBuffer(
    handle: BufferHandle,
    usage: ComputeBufferWriteUsage,
    range?: BufferRange
  ): BufferHandle {
    if (usage !== 'storage-write') {
      throw new Error(
        `Compute pass cannot declare buffer write usage "${usage}". Only "storage-write" is allowed.`
      );
    }
    return this.declareWriteBuffer(handle, usage, range);
  }

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

export class CopyPassBuilderImpl extends BaseGraphResourceBuilder implements CopyPassBuilder {
  writeTexture(
    handle: TextureHandle,
    usage: CopyTextureWriteUsage,
    range?: TextureRange
  ): TextureHandle {
    if (usage !== 'copy-dst') {
      throw new Error(
        `Copy pass cannot declare texture write usage "${usage}". Only "copy-dst" is allowed.`
      );
    }
    return this.declareWriteTexture(handle, usage, range);
  }

  writeBuffer(
    handle: BufferHandle,
    usage: CopyBufferWriteUsage,
    range?: BufferRange
  ): BufferHandle {
    if (usage !== 'copy-dst') {
      throw new Error(
        `Copy pass cannot declare buffer write usage "${usage}". Only "copy-dst" is allowed.`
      );
    }
    return this.declareWriteBuffer(handle, usage, range);
  }
}
