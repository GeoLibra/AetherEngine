import type {
  GraphHandle,
  PortableTransition,
  RasterGroupPlan,
  RenderGraphExecutionPlan
} from '../types';
import type { RenderGraphSnapshot } from '../builder/builder';
import type { RHIBuffer, RHITexture } from '../../rhi/contracts';

/**
 * Validates that all resource transitions and aliasing decisions in the execution plan
 * respect physical pass boundaries and WebGPU per-pass usage scope invariants.
 *
 * @param plan - The compiled canonical execution plan to validate.
 * @throws Error if an incompatible transition occurs within the same physical pass or if aliased resources overlap.
 */
export function validatePhysicalTransitionsAndPassBoundaries(plan: RenderGraphExecutionPlan): void {
  const { compiled, rasterGroups, schedule, aliases, transitions } = plan;

  // 1. Build mapping from retained passId to physical execution step identity
  const passToPhysicalStep = new Map<number, { isRasterGroup: boolean; id: number }>();

  for (const group of rasterGroups) {
    for (const retainedIndex of group.retainedPassIndices) {
      const passId = compiled.order[retainedIndex];
      if (passId !== undefined) {
        passToPhysicalStep.set(passId, { isRasterGroup: true, id: group.groupIndex });
      }
    }
  }

  for (let stepIndex = 0; stepIndex < schedule.length; stepIndex++) {
    const step = schedule[stepIndex]!;
    if (step.kind === 'pass') {
      passToPhysicalStep.set(step.passId, { isRasterGroup: false, id: stepIndex });
    }
  }

  // 2. Validate that usage transitions between conflicting usages cross physical pass boundaries
  validateTransitionBoundaries(transitions, passToPhysicalStep);

  // 3. Validate that aliased transient resources never share a physical execution step
  validateAliasedStepIsolation(schedule, compiled, rasterGroups, aliases);
}

/**
 * Asserts that any transition between conflicting usages occurs across separate physical passes.
 */
function validateTransitionBoundaries(
  transitions: readonly PortableTransition[],
  passToPhysicalStep: ReadonlyMap<number, { isRasterGroup: boolean; id: number }>
): void {
  for (const transition of transitions) {
    if (transition.fromPassId === null || transition.fromPassId === transition.toPassId) continue;

    const fromStep = passToPhysicalStep.get(transition.fromPassId);
    const toStep = passToPhysicalStep.get(transition.toPassId);

    if (fromStep === undefined || toStep === undefined) continue;

    // If both passes execute inside the same physical raster group
    if (fromStep.isRasterGroup && toStep.isRasterGroup && fromStep.id === toStep.id) {
      if (isConflictingWithinPhysicalPass(transition)) {
        throw new Error(
          `Render graph transition for resource ${transition.resourceId} from "${transition.beforeUsage}" (pass ${transition.fromPassId}) to "${transition.afterUsage}" (pass ${transition.toPassId}) cannot occur within the same physical raster group ${fromStep.id}. A physical pass boundary is required.`
        );
      }
    }
  }
}

/**
 * Determines if a transition represents mutually exclusive usages within a single physical pass.
 */
function isConflictingWithinPhysicalPass(transition: PortableTransition): boolean {
  const { beforeUsage, afterUsage, resourceKind } = transition;
  if (beforeUsage === afterUsage) return false;

  if (resourceKind === 'texture') {
    const isAttachment = (u: string) =>
      u === 'color-attachment' || u === 'depth-stencil-attachment';
    const isShaderOrCopy = (u: string) =>
      u === 'sampled' ||
      u === 'storage-read' ||
      u === 'storage-write' ||
      u === 'copy-src' ||
      u === 'copy-dst' ||
      u === 'present';

    if (
      (isAttachment(beforeUsage) && isShaderOrCopy(afterUsage)) ||
      (isShaderOrCopy(beforeUsage) && isAttachment(afterUsage))
    ) {
      return true;
    }
  } else if (resourceKind === 'buffer') {
    const isWrite = (u: string) => u === 'storage-write' || u === 'copy-dst';
    const isRead = (u: string) =>
      u === 'vertex' ||
      u === 'index' ||
      u === 'uniform' ||
      u === 'storage-read' ||
      u === 'indirect' ||
      u === 'copy-src';

    if (
      (isWrite(beforeUsage) && isRead(afterUsage)) ||
      (isRead(beforeUsage) && isWrite(afterUsage))
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Asserts that aliased transient resources (sharing an allocationId) are never active within
 * the same physical raster group or standalone pass.
 */
function validateAliasedStepIsolation(
  schedule: RenderGraphExecutionPlan['schedule'],
  compiled: RenderGraphExecutionPlan['compiled'],
  rasterGroups: readonly RasterGroupPlan[],
  aliases: RenderGraphExecutionPlan['aliases']
): void {
  const resourceToAllocation = new Map<number, number>();
  for (const decision of aliases.decisions) {
    if (decision.allocationId !== null) {
      resourceToAllocation.set(decision.resourceId, decision.allocationId);
    }
  }

  const rasterGroupMap = new Map(rasterGroups.map((g) => [g.groupIndex, g]));

  for (let stepIndex = 0; stepIndex < schedule.length; stepIndex++) {
    const step = schedule[stepIndex]!;
    const activeAllocations = new Map<number, number>(); // allocationId -> logicalResourceId

    if (step.kind === 'raster-group') {
      const group = rasterGroupMap.get(step.groupIndex);
      if (group === undefined) continue;
      for (const passIndex of group.retainedPassIndices) {
        const pass = compiled.retainedPasses[passIndex];
        if (pass === undefined) continue;
        checkPassAllocations(
          pass.accesses,
          resourceToAllocation,
          activeAllocations,
          `raster group ${group.groupIndex}`
        );
      }
    } else if (step.kind === 'pass') {
      const pass = compiled.retainedPasses[step.retainedPassIndex];
      if (pass === undefined) continue;
      checkPassAllocations(
        pass.accesses,
        resourceToAllocation,
        activeAllocations,
        `pass "${pass.id}"`
      );
    }
  }
}

function checkPassAllocations(
  accesses: readonly { readonly handle: { readonly resourceId: number } }[],
  resourceToAllocation: ReadonlyMap<number, number>,
  activeAllocations: Map<number, number>,
  contextName: string
): void {
  for (const access of accesses) {
    const resId = access.handle.resourceId;
    const allocId = resourceToAllocation.get(resId);
    if (allocId !== undefined) {
      const existingResId = activeAllocations.get(allocId);
      if (existingResId !== undefined && existingResId !== resId) {
        throw new Error(
          `Render graph physical ${contextName} illegally accesses aliased resources ${existingResId} and ${resId} which share physical allocation ${allocId}.`
        );
      }
      activeAllocations.set(allocId, resId);
    }
  }
}

/**
 * Validates that distinct imported resources do not share the exact same physical resource instance.
 *
 * @param snapshot - The graph snapshot containing resource declarations.
 * @param resources - The map from graph handle to resolved physical resources.
 * @throws Error if two distinct imported resources share a physical texture or buffer.
 */
export function validateImportedStorageUniqueness(
  snapshot: RenderGraphSnapshot,
  resources: ReadonlyMap<GraphHandle, RHITexture | RHIBuffer>
): void {
  const importedSeen = new Map<RHITexture | RHIBuffer, number>();

  for (const resource of snapshot.resources) {
    if (resource.origin.kind !== 'imported') continue;
    const handle = resource.versions[0]?.handle;
    if (handle === undefined) continue;
    const physical = resources.get(handle);
    if (physical === undefined) continue;

    const existingResId = importedSeen.get(physical);
    if (existingResId !== undefined && existingResId !== resource.resourceId) {
      throw new Error(
        `Render graph imported resources ${existingResId} and ${resource.resourceId} cannot share physical identity.`
      );
    }
    importedSeen.set(physical, resource.resourceId);
  }
}
