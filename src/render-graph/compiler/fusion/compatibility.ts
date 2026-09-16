import type {
  CompiledRenderGraph,
  GraphPassDeclaration,
  NormalizedFusionOptions,
  RasterGroupPlan,
  RenderGraphSnapshot
} from '../../types';
import { SplitReasonCode } from './constants';
import {
  compareColorSignatures,
  compareExistingDepthSignatures,
  type RasterPassSignature
} from './signature';
import { evaluateResidencyBudget } from './residency';
import type { ActiveRasterGroup, FusionEvaluation, MutableFusionCounters } from './types';

export function evaluateCandidateFusion(
  activeGroup: ActiveRasterGroup,
  candidatePass: GraphPassDeclaration,
  candidateSig: RasterPassSignature,
  snapshot: RenderGraphSnapshot,
  compiled: CompiledRenderGraph,
  options: NormalizedFusionOptions,
  committedGroups: readonly RasterGroupPlan[],
  counters: MutableFusionCounters
): FusionEvaluation {
  // 1. Group pass limit
  if (
    options.maxGroupPassCount !== 'unlimited' &&
    activeGroup.members.length + 1 > options.maxGroupPassCount
  ) {
    return { splitReason: SplitReasonCode.GroupPassLimit, lateDepthSafe: false };
  }

  // 2. Color attachments compatibility
  const colorReason = compareColorSignatures(activeGroup.signature, candidateSig);
  if (colorReason !== null) {
    return { splitReason: colorReason, lateDepthSafe: false };
  }

  // 3. Initial operations check (intervening clear requires boundary)
  if (hasInterveningClear(activeGroup.signature, candidateSig, candidatePass)) {
    return { splitReason: SplitReasonCode.IntermediateClear, lateDepthSafe: false };
  }

  // 4. Resolve boundary (no intermediate resolve)
  if (hasIntermediateResolve(activeGroup.members)) {
    return { splitReason: SplitReasonCode.ResolveBoundary, lateDepthSafe: false };
  }

  // 5. Depth/stencil compatibility and Safe Late Depth Introduction
  const depthResult = evaluateDepthCompatibility(activeGroup, candidatePass, candidateSig);
  if (depthResult.splitReason !== null) {
    return depthResult;
  }

  // 6. Usage scope check
  counters.usageComparisons++;
  if (activeGroup.usageAccumulator.hasUsageConflictWith(candidatePass)) {
    return { splitReason: SplitReasonCode.UsageScopeConflict, lateDepthSafe: false };
  }

  // 7. Residency budget
  if (options.maxResidencyExpansionBytes !== 'unlimited') {
    const budgetReason = evaluateResidencyBudget(
      activeGroup.members,
      candidatePass,
      snapshot,
      compiled,
      options.maxResidencyExpansionBytes,
      committedGroups.map((group) =>
        group.retainedPassIndices.map((index) => compiled.retainedPasses[index]!)
      )
    );
    if (budgetReason !== null) {
      return { splitReason: budgetReason, lateDepthSafe: false };
    }
  }

  return { splitReason: null, lateDepthSafe: depthResult.lateDepthSafe };
}

function hasInterveningClear(
  activeSig: RasterPassSignature,
  candidateSig: RasterPassSignature,
  candidatePass: GraphPassDeclaration
): boolean {
  const details = candidatePass.rasterDetails;
  if (details === undefined) return false;

  const hasColorClear = details.colorAttachments.some((color) => color.options.load === 'clear');
  if (hasColorClear) return true;

  if (activeSig.depthStencil !== undefined && candidateSig.depthStencil !== undefined) {
    return details.depthStencilAttachment?.options.depthLoad === 'clear';
  }

  return false;
}

function hasIntermediateResolve(members: readonly GraphPassDeclaration[]): boolean {
  return members.some((member) => (member.rasterDetails?.resolveAttachments.length ?? 0) > 0);
}

function evaluateDepthCompatibility(
  activeGroup: ActiveRasterGroup,
  candidatePass: GraphPassDeclaration,
  candidateSig: RasterPassSignature
): FusionEvaluation {
  const accDepth = activeGroup.signature.depthStencil;
  const candDepth = candidateSig.depthStencil;

  if (accDepth !== undefined && candDepth !== undefined) {
    return {
      splitReason: compareExistingDepthSignatures(accDepth, candDepth),
      lateDepthSafe: false
    };
  }

  if (accDepth !== undefined && candDepth === undefined) {
    return { splitReason: SplitReasonCode.DepthIntroductionUnproven, lateDepthSafe: false };
  }

  if (accDepth === undefined && candDepth !== undefined) {
    const details = candidatePass.rasterDetails;
    const clearsDepth = details?.depthStencilAttachment?.options.depthLoad === 'clear';
    if (!clearsDepth) {
      return { splitReason: SplitReasonCode.DepthIntroductionUnproven, lateDepthSafe: false };
    }

    const depthResourceId = candDepth.resourceId;
    const depthAccessedEarlier = activeGroup.members.some((member) =>
      member.accesses.some((access) => access.handle.resourceId === depthResourceId)
    );

    if (depthAccessedEarlier) {
      return { splitReason: SplitReasonCode.DepthIntroductionUnproven, lateDepthSafe: false };
    }

    return { splitReason: null, lateDepthSafe: true };
  }

  return { splitReason: null, lateDepthSafe: false };
}
