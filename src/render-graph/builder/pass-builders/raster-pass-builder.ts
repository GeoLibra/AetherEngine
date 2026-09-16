import { assertGraphHandle } from '../handles';
import { BaseGraphResourceBuilder } from './base-pass-builder';
import type {
  ColorAttachmentOptions,
  DeclaredColorAttachment,
  DeclaredDepthStencilAttachment,
  DeclaredResolveAttachment,
  DepthStencilAttachmentOptions,
  PreparedDrawResourcesToken,
  PreparedRenderPipelineToken,
  RasterPassBuilder,
  RasterPassDeclarationDetails,
  TextureDescriptor,
  TextureHandle,
  TextureRange
} from '../../types';

/**
 * Restricted builder implementation for raster passes. Enforces attachment-only writes
 * and prevents buffer write declarations.
 */
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
