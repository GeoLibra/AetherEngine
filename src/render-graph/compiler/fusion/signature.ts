import type {
  GraphPassDeclaration,
  RenderGraphSnapshot,
  TextureDescriptor,
  TextureRange
} from '../../types';
import { SplitReasonCode } from './constants';

export interface ColorAttachmentSignature {
  readonly slot: number;
  readonly resourceId: number;
  readonly range: TextureRange;
  readonly format: string;
  readonly width: number;
  readonly height: number;
  readonly sampleCount: number;
}

export interface DepthStencilAttachmentSignature {
  readonly resourceId: number;
  readonly range: TextureRange;
  readonly format: string;
  readonly width: number;
  readonly height: number;
  readonly sampleCount: number;
  readonly depthAccess: 'read' | 'write';
  readonly stencilAccess: 'read' | 'write';
}

export interface ResolveAttachmentSignature {
  readonly slot: number;
  readonly sourceId: number;
  readonly destinationId: number;
}

export interface RasterPassSignature {
  readonly colorSlots: readonly ColorAttachmentSignature[];
  readonly depthStencil?: DepthStencilAttachmentSignature | undefined;
  readonly resolves: readonly ResolveAttachmentSignature[];
}

export function defaultTextureRange(desc: TextureDescriptor): TextureRange {
  return Object.freeze({
    baseMipLevel: 0,
    mipLevelCount: 1,
    baseArrayLayer: 0,
    arrayLayerCount: 1,
    aspect: 'all' as const
  });
}

/** Extracts normalized raster attachment signatures from a declared raster pass. */
export function extractRasterSignature(
  pass: GraphPassDeclaration,
  snapshot: RenderGraphSnapshot
): RasterPassSignature {
  const details = pass.rasterDetails;
  if (details === undefined) {
    throw new Error(`Pass "${pass.id}" has no raster details.`);
  }

  const resourceMap = new Map(snapshot.resources.map((r) => [r.resourceId, r]));
  const colorSlots: ColorAttachmentSignature[] = [];
  for (const declared of details.colorAttachments) {
    const resource = resourceMap.get(declared.input.resourceId);
    if (resource === undefined || resource.kind !== 'texture') {
      throw new Error(
        `Color attachment references an unknown texture resource ${declared.input.resourceId}.`
      );
    }
    const desc = resource.descriptor as TextureDescriptor;
    colorSlots.push(
      Object.freeze({
        slot: declared.slot,
        resourceId: resource.resourceId,
        range: declared.options.range ?? defaultTextureRange(desc),
        format: desc.format,
        width: desc.width,
        height: desc.height,
        sampleCount: desc.sampleCount
      })
    );
  }

  let depthStencil: DepthStencilAttachmentSignature | undefined;
  if (details.depthStencilAttachment !== undefined) {
    const declared = details.depthStencilAttachment;
    const resource = resourceMap.get(declared.input.resourceId);
    if (resource === undefined || resource.kind !== 'texture') {
      throw new Error(
        `Depth/stencil attachment references an unknown texture resource ${declared.input.resourceId}.`
      );
    }
    const desc = resource.descriptor as TextureDescriptor;
    depthStencil = Object.freeze({
      resourceId: resource.resourceId,
      range: declared.options.range ?? defaultTextureRange(desc),
      format: desc.format,
      width: desc.width,
      height: desc.height,
      sampleCount: desc.sampleCount,
      depthAccess: declared.options.depthAccess ?? 'write',
      stencilAccess: declared.options.stencilAccess ?? 'write'
    });
  }

  const resolves: ResolveAttachmentSignature[] = [];
  for (const declared of details.resolveAttachments) {
    resolves.push(
      Object.freeze({
        slot: declared.slot,
        sourceId: declared.source.resourceId,
        destinationId: declared.destination.resourceId
      })
    );
  }

  return Object.freeze({
    colorSlots: Object.freeze(colorSlots),
    depthStencil,
    resolves: Object.freeze(resolves)
  });
}

/** Compares color attachment signatures between two passes or a group and a candidate. */
export function compareColorSignatures(
  accumulated: RasterPassSignature,
  candidate: RasterPassSignature
): SplitReasonCode | null {
  if (accumulated.colorSlots.length !== candidate.colorSlots.length) {
    return SplitReasonCode.AttachmentIdentityMismatch;
  }
  for (const accColor of accumulated.colorSlots) {
    const candColor = candidate.colorSlots.find((c) => c.slot === accColor.slot);
    if (candColor === undefined || accColor.resourceId !== candColor.resourceId) {
      return SplitReasonCode.AttachmentIdentityMismatch;
    }
    if (!areTextureRangesEqual(accColor.range, candColor.range)) {
      return SplitReasonCode.AttachmentViewMismatch;
    }
    if (
      accColor.format !== candColor.format ||
      accColor.width !== candColor.width ||
      accColor.height !== candColor.height ||
      accColor.sampleCount !== candColor.sampleCount
    ) {
      return SplitReasonCode.AttachmentLayoutMismatch;
    }
  }
  return null;
}

/** Compares depth/stencil attachment signatures when both are present. */
export function compareExistingDepthSignatures(
  accDepth: DepthStencilAttachmentSignature,
  candDepth: DepthStencilAttachmentSignature
): SplitReasonCode | null {
  if (accDepth.resourceId !== candDepth.resourceId) {
    return SplitReasonCode.AttachmentIdentityMismatch;
  }
  if (!areTextureRangesEqual(accDepth.range, candDepth.range)) {
    return SplitReasonCode.AttachmentViewMismatch;
  }
  if (
    accDepth.format !== candDepth.format ||
    accDepth.width !== candDepth.width ||
    accDepth.height !== candDepth.height ||
    accDepth.sampleCount !== candDepth.sampleCount
  ) {
    return SplitReasonCode.AttachmentLayoutMismatch;
  }
  if (
    accDepth.depthAccess !== candDepth.depthAccess ||
    accDepth.stencilAccess !== candDepth.stencilAccess
  ) {
    return SplitReasonCode.AttachmentViewMismatch;
  }
  return null;
}

export function areTextureRangesEqual(first: TextureRange, second: TextureRange): boolean {
  return (
    first.baseMipLevel === second.baseMipLevel &&
    first.mipLevelCount === second.mipLevelCount &&
    first.baseArrayLayer === second.baseArrayLayer &&
    first.arrayLayerCount === second.arrayLayerCount &&
    first.aspect === second.aspect
  );
}
