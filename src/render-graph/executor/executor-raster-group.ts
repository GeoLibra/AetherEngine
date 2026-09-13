import type {
  RHIBuffer,
  RHICommandEncoder,
  RHIDevice,
  RHIRenderPassDepthStencilAttachment,
  RHITexture,
  RHITextureView
} from '../../rhi/contracts';
import { normalizeTextureRange } from '../ranges';
import { RasterPassContextImpl } from '../context/raster-context';
import { RestrictedContext } from '../context/restricted-context';
import type { EndableRenderPass } from './executor-cleanup';
import type { RenderGraphExecutionInputs } from './executor-bindings';
import { toViewDescriptor } from './executor-resource-utils';
import type {
  GraphHandle,
  RasterGroupPlan,
  RenderGraphExecutionPlan,
  TextureDescriptor
} from '../types';

type ActivePass = EndableRenderPass;

/**
 * Executes one fused physical raster group within an active command encoder.
 *
 * - Acquires and binds physical color, depth/stencil, and resolve attachment views once.
 * - Opens the physical render pass with beginRenderPass().
 * - Dispatches member logical passes with isolated RasterPassContext facades.
 * - Restores default attachment viewport and scissor between passes.
 * - Closes the physical render pass exactly once on completion or failure.
 */
export function executeRasterGroup(
  group: RasterGroupPlan,
  plan: RenderGraphExecutionPlan,
  inputs: RenderGraphExecutionInputs,
  resources: ReadonlyMap<GraphHandle, RHITexture | RHIBuffer>,
  encoder: RHICommandEncoder,
  restrictedContexts: RestrictedContext[],
  onActivePass: (pass: ActivePass | undefined) => void
): number {
  const resourceRecords = new Map(plan.snapshot.resources.map((r) => [r.resourceId, r]));

  function getPhysicalTexture(resourceId: number): RHITexture {
    const record = resourceRecords.get(resourceId);
    if (record === undefined || record.kind !== 'texture') {
      throw new Error(`Cannot resolve texture resource ${resourceId}`);
    }
    const handle = record.versions[0]?.handle;
    const physical = handle !== undefined ? resources.get(handle) : undefined;
    if (physical === undefined || physical.kind !== 'texture') {
      throw new Error(`Physical texture not found for resource ${resourceId}`);
    }
    return physical;
  }

  // 1. Resolve color attachments
  const groupViews: RHITextureView[] = [];
  const orderedColorPlans = [...group.attachments.colorAttachments].sort(
    (first, second) => first.slot - second.slot
  );
  orderedColorPlans.forEach((colorPlan, index) => {
    if (colorPlan.slot !== index) {
      throw new Error('Physical raster color attachment slots must be contiguous from slot 0.');
    }
  });
  const colorAttachments = orderedColorPlans.map((colorPlan) => {
    const texture = getPhysicalTexture(colorPlan.resourceId);
    const record = resourceRecords.get(colorPlan.resourceId)!;
    const normalizedRange = normalizeTextureRange(
      record.descriptor as TextureDescriptor,
      colorPlan.range
    );
    const view = texture.createView(toViewDescriptor(normalizedRange));
    groupViews.push(view);

    let resolveTarget: RHITextureView | undefined;
    if (
      colorPlan.resolveDestinationId !== undefined &&
      colorPlan.resolveDestinationRange !== undefined
    ) {
      const resolveTexture = getPhysicalTexture(colorPlan.resolveDestinationId);
      const resolveRecord = resourceRecords.get(colorPlan.resolveDestinationId)!;
      const normalizedResolveRange = normalizeTextureRange(
        resolveRecord.descriptor as TextureDescriptor,
        colorPlan.resolveDestinationRange
      );
      resolveTarget = resolveTexture.createView(toViewDescriptor(normalizedResolveRange));
      groupViews.push(resolveTarget);
    }

    return {
      view,
      loadOp: colorPlan.loadOp,
      storeOp: colorPlan.storeOp,
      ...(colorPlan.clearValue !== undefined ? { clearValue: colorPlan.clearValue } : {}),
      ...(resolveTarget !== undefined ? { resolveTarget } : {})
    };
  });

  // 2. Resolve depth/stencil attachment
  let depthStencilAttachment: RHIRenderPassDepthStencilAttachment | undefined;
  if (group.attachments.depthStencilAttachment !== undefined) {
    const depthPlan = group.attachments.depthStencilAttachment;
    const depthTexture = getPhysicalTexture(depthPlan.resourceId);
    const depthRecord = resourceRecords.get(depthPlan.resourceId)!;
    const normalizedDepthRange = normalizeTextureRange(
      depthRecord.descriptor as TextureDescriptor,
      depthPlan.range
    );
    const depthView = depthTexture.createView(toViewDescriptor(normalizedDepthRange));
    groupViews.push(depthView);

    depthStencilAttachment = {
      view: depthView,
      ...(depthPlan.depthLoadOp !== undefined ? { depthLoadOp: depthPlan.depthLoadOp } : {}),
      ...(depthPlan.depthStoreOp !== undefined ? { depthStoreOp: depthPlan.depthStoreOp } : {}),
      ...(depthPlan.depthClearValue !== undefined
        ? { depthClearValue: depthPlan.depthClearValue }
        : {}),
      ...(depthPlan.depthReadOnly !== undefined ? { depthReadOnly: depthPlan.depthReadOnly } : {}),
      ...(depthPlan.stencilLoadOp !== undefined ? { stencilLoadOp: depthPlan.stencilLoadOp } : {}),
      ...(depthPlan.stencilStoreOp !== undefined
        ? { stencilStoreOp: depthPlan.stencilStoreOp }
        : {}),
      ...(depthPlan.stencilClearValue !== undefined
        ? { stencilClearValue: depthPlan.stencilClearValue }
        : {}),
      ...(depthPlan.stencilReadOnly !== undefined
        ? { stencilReadOnly: depthPlan.stencilReadOnly }
        : {})
    };
  }

  // Determine viewport dimensions from the first attachment's physical subresource extent.
  // A mip>0 attachment backs a render pass whose frame buffer is smaller than the full
  // descriptor; the default viewport and scissor must match the attached subresource size.
  let width = 0;
  let height = 0;
  if (group.attachments.colorAttachments.length > 0) {
    const firstColor = group.attachments.colorAttachments[0]!;
    const texRecord = resourceRecords.get(firstColor.resourceId)!;
    const desc = texRecord.descriptor as TextureDescriptor;
    const normalizedRange = normalizeTextureRange(desc, firstColor.range);
    width = Math.max(1, desc.width >> normalizedRange.baseMipLevel);
    height = Math.max(1, desc.height >> normalizedRange.baseMipLevel);
  } else if (group.attachments.depthStencilAttachment !== undefined) {
    const depthPlan = group.attachments.depthStencilAttachment;
    const texRecord = resourceRecords.get(depthPlan.resourceId)!;
    const desc = texRecord.descriptor as TextureDescriptor;
    const normalizedRange = normalizeTextureRange(desc, depthPlan.range);
    width = Math.max(1, desc.width >> normalizedRange.baseMipLevel);
    height = Math.max(1, desc.height >> normalizedRange.baseMipLevel);
  }

  // 3. Open physical render pass
  const renderPass = encoder.beginRenderPass({
    label: `raster-group-${group.groupIndex}`,
    colorAttachments,
    ...(depthStencilAttachment !== undefined ? { depthStencilAttachment } : {})
  });
  onActivePass(renderPass);

  try {
    for (const retainedPassIndex of group.retainedPassIndices) {
      const pass = plan.compiled.retainedPasses[retainedPassIndex]!;

      // Restore full viewport & scissor
      if (width > 0 && height > 0) {
        renderPass.setViewport(0, 0, width, height, 0, 1);
        renderPass.setScissorRect(0, 0, width, height);
      }

      // Create isolated logical context
      const restrictedContext = new RestrictedContext(
        pass.accesses,
        resources,
        resourceRecords,
        inputs.device,
        inputs.preparedRenderPipelines ?? new Map(),
        inputs.preparedComputePipelines ?? new Map(),
        inputs.preparedBindGroupLayouts ?? new Map(),
        inputs.preparedDrawResources ?? new Map(),
        encoder,
        pass.rasterDetails === undefined
          ? undefined
          : {
              renderPipelines: pass.rasterDetails.preparedRenderPipelines,
              drawResources: pass.rasterDetails.preparedDrawResources
            }
      );
      restrictedContexts.push(restrictedContext);

      const rasterContext = new RasterPassContextImpl(restrictedContext, renderPass);
      try {
        pass.run(rasterContext);
      } finally {
        rasterContext.revoke();
        restrictedContext.close();
      }
    }
  } catch (error) {
    // Cleanup must preserve the callback failure as the primary diagnostic.
    onActivePass(undefined);
    try {
      renderPass.end();
    } catch {}
    throw error;
  }
  onActivePass(undefined);
  renderPass.end();

  return group.retainedPassIndices.length;
}
