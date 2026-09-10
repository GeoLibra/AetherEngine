import type { GraphPassDeclaration, RenderGraphSnapshot } from '../../builder/builder';
import type { CompiledRenderGraph, TextureDescriptor } from '../../types';
import { defaultTextureRange } from './signature';
import type {
  PhysicalAttachmentPlan,
  PhysicalColorAttachmentPlan,
  PhysicalDepthStencilAttachmentPlan
} from '../../types';

/**
 * Lowers physical load/store/resolve operations for a fused raster group.
 *
 * - The first member with an attachment defines physical loadOp and clearValue.
 * - If late depth introduction was proven, the depth clear is lifted to group begin.
 * - The final member defines physical storeOp (evaluated against downstream consumers for 'auto').
 * - Group-terminal resolve is configured if declared by the final member.
 */
export function lowerPhysicalAttachmentOperations(
  groupMembers: readonly GraphPassDeclaration[],
  snapshot: RenderGraphSnapshot,
  compiled: CompiledRenderGraph,
  lateDepthIntroduced = false
): PhysicalAttachmentPlan {
  if (groupMembers.length === 0) {
    throw new Error('Cannot lower physical attachment operations for an empty group.');
  }

  const resourceMap = new Map(snapshot.resources.map((r) => [r.resourceId, r]));
  const firstMember = groupMembers[0]!;
  const lastMember = groupMembers[groupMembers.length - 1]!;

  // Lower color attachments
  const colorAttachments: PhysicalColorAttachmentPlan[] = [];
  const firstRaster = firstMember.rasterDetails;
  const lastRaster = lastMember.rasterDetails;

  if (firstRaster !== undefined && lastRaster !== undefined) {
    const lastColorMap = new Map(lastRaster.colorAttachments.map((c) => [c.slot, c]));
    const lastResolveMap = new Map(lastRaster.resolveAttachments.map((r) => [r.slot, r]));

    for (const firstColor of firstRaster.colorAttachments) {
      const slot = firstColor.slot;
      const lastColor = lastColorMap.get(slot) ?? firstColor;
      const loadOp = firstColor.options.load;
      const clearValue = firstColor.options.clearValue;
      const resource = resourceMap.get(firstColor.input.resourceId);
      const desc = resource?.descriptor as TextureDescriptor;
      const range = firstColor.options.range ?? defaultTextureRange(desc);

      let storeOp: 'store' | 'discard';
      if (lastColor.options.store === 'store') {
        storeOp = 'store';
      } else if (lastColor.options.store === 'discard') {
        storeOp = 'discard';
      } else {
        // 'auto': store if consumed downstream or terminated
        const isConsumed = isResourceConsumedDownstream(
          lastMember.token.passId,
          lastColor.output.resourceId,
          snapshot,
          compiled
        );
        storeOp = isConsumed ? 'store' : 'discard';
      }

      const resolve = lastResolveMap.get(slot);

      colorAttachments.push(
        Object.freeze({
          slot,
          resourceId: firstColor.input.resourceId,
          range,
          loadOp,
          clearValue,
          storeOp,
          resolveDestinationId: resolve?.destination.resourceId,
          resolveDestinationRange: resolve?.destinationRange
        })
      );
    }
  }

  // Lower depth/stencil attachment
  let depthStencilAttachment: PhysicalDepthStencilAttachmentPlan | undefined;
  const membersWithDepth = groupMembers.filter(
    (m) => m.rasterDetails?.depthStencilAttachment !== undefined
  );

  if (membersWithDepth.length > 0) {
    const firstDepthPass = membersWithDepth[0]!;
    const lastDepthPass = membersWithDepth[membersWithDepth.length - 1]!;
    const firstDepth = firstDepthPass.rasterDetails!.depthStencilAttachment!;
    const lastDepth = lastDepthPass.rasterDetails!.depthStencilAttachment!;
    const resource = resourceMap.get(firstDepth.input.resourceId);
    const desc = resource?.descriptor as TextureDescriptor;
    const range = firstDepth.options.range ?? defaultTextureRange(desc);

    let depthLoadOp: 'load' | 'clear' | undefined;
    let depthClearValue: number | undefined;
    if (lateDepthIntroduced) {
      // Safe late depth clear lifted to group begin
      depthLoadOp = 'clear';
      depthClearValue = firstDepth.options.depthClearValue;
    } else {
      depthLoadOp = firstDepth.options.depthLoad;
      depthClearValue = firstDepth.options.depthClearValue;
    }

    let depthStoreOp: 'store' | 'discard' | undefined;
    if (lastDepth.options.depthStore === 'store') {
      depthStoreOp = 'store';
    } else if (lastDepth.options.depthStore === 'discard') {
      depthStoreOp = 'discard';
    } else if (lastDepth.options.depthStore !== undefined) {
      const isConsumed = isResourceConsumedDownstream(
        lastDepthPass.token.passId,
        lastDepth.input.resourceId,
        snapshot,
        compiled
      );
      depthStoreOp = isConsumed ? 'store' : 'discard';
    }

    const depthReadOnly = membersWithDepth.every(
      (m) => m.rasterDetails?.depthStencilAttachment?.options.depthAccess === 'read'
    );
    const stencilReadOnly = membersWithDepth.every(
      (m) => m.rasterDetails?.depthStencilAttachment?.options.stencilAccess === 'read'
    );

    depthStencilAttachment = Object.freeze({
      resourceId: firstDepth.input.resourceId,
      range,
      depthLoadOp,
      depthClearValue,
      depthStoreOp,
      depthReadOnly,
      stencilLoadOp: firstDepth.options.stencilLoad,
      stencilClearValue: firstDepth.options.stencilClearValue,
      stencilStoreOp:
        lastDepth.options.stencilStore === 'auto'
          ? isResourceConsumedDownstream(
              lastDepthPass.token.passId,
              lastDepth.input.resourceId,
              snapshot,
              compiled
            )
            ? 'store'
            : 'discard'
          : lastDepth.options.stencilStore,
      stencilReadOnly
    });
  }

  return Object.freeze({
    colorAttachments: Object.freeze(colorAttachments),
    depthStencilAttachment
  });
}

function isResourceConsumedDownstream(
  passId: number,
  resourceId: number,
  snapshot: RenderGraphSnapshot,
  compiled: CompiledRenderGraph
): boolean {
  for (const terminal of snapshot.terminals) {
    if (terminal.passId === passId && terminal.handle.resourceId === resourceId) {
      return true;
    }
  }
  for (const edge of compiled.edges) {
    if (edge.kind !== 'semantic' && edge.fromPassId === passId && edge.resourceId === resourceId) {
      return true;
    }
  }
  return false;
}
