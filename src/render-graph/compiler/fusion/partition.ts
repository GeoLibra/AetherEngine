import type { GraphPassDeclaration, RenderGraphSnapshot } from '../../builder/builder';
import type { CompiledRenderGraph } from '../../types';
import { SplitReasonCode } from './constants';
import { lowerPhysicalAttachmentOperations } from './attachment-lowering';
import { extractRasterSignature } from './signature';
import type {
  BoundarySplitRecord,
  GroupPartitionResult,
  NormalizedFusionOptions,
  PassFusionOptions,
  RasterGroupPlan
} from '../../types';
import { GroupUsageAccumulator } from './usage';
import { summarizeFusionResidency } from './residency';
import { evaluateCandidateFusion } from './compatibility';
import type { ActiveRasterGroup, MutableFusionCounters } from './types';

/** Validates and normalizes pass fusion options according to RenderGraph §13.8. */
export function validateFusionOptions(options?: PassFusionOptions): NormalizedFusionOptions {
  const enablePassFusion = options?.enablePassFusion ?? true;

  let maxResidencyExpansionBytes: number | 'unlimited' = 'unlimited';
  if (options?.maxResidencyExpansionBytes !== undefined) {
    const val = options.maxResidencyExpansionBytes;
    if (val !== 'unlimited') {
      if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 0) {
        throw new Error(
          `Pass fusion maxResidencyExpansionBytes must be a nonnegative safe integer or 'unlimited', got ${String(val)}.`
        );
      }
      maxResidencyExpansionBytes = val;
    }
  }

  let maxGroupPassCount: number | 'unlimited' = 'unlimited';
  if (options?.maxGroupPassCount !== undefined) {
    const val = options.maxGroupPassCount;
    if (val !== 'unlimited') {
      if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 1) {
        throw new Error(
          `Pass fusion maxGroupPassCount must be a positive safe integer or 'unlimited', got ${String(val)}.`
        );
      }
      maxGroupPassCount = val;
    }
  }

  return Object.freeze({
    enablePassFusion,
    maxResidencyExpansionBytes,
    maxGroupPassCount
  });
}

/**
 * Deterministically partitions consecutive retained raster passes into physical groups
 * evaluating the compatibility criteria, safe late depth proof, and residency budget.
 */
export function partitionRasterGroups(
  snapshot: RenderGraphSnapshot,
  compiled: CompiledRenderGraph,
  options?: PassFusionOptions
): GroupPartitionResult {
  const normalizedOptions = validateFusionOptions(options);
  const retainedMap = new Map(
    compiled.retainedPasses.map((p, idx) => [p.token.passId, { pass: p, idx }])
  );

  let logicalRasterPassCount = 0;
  for (const passId of compiled.order) {
    const item = retainedMap.get(passId);
    if (item !== undefined && item.pass.passKind === 'raster') {
      logicalRasterPassCount++;
    }
  }

  const counters: MutableFusionCounters = {
    retainedLogicalRasterPasses: logicalRasterPassCount,
    physicalRasterGroups: 0,
    fusedBoundariesCount: 0,
    examinedCandidates: 0,
    usageComparisons: 0,
    stateRestorationCommands: 0,
    physicalLifetimeExpansionBytes: 0,
    peakTransientBytes: 0
  };

  const splitRecords: BoundarySplitRecord[] = [];
  const groups: RasterGroupPlan[] = [];
  let activeGroup: ActiveRasterGroup | undefined;

  const flushActiveGroup = (): void => {
    if (activeGroup === undefined) return;
    groups.push(lowerRasterGroupPlan(activeGroup, groups.length, snapshot, compiled, retainedMap));
    counters.physicalRasterGroups++;
    activeGroup = undefined;
  };

  let lastRasterPassId: number | undefined;

  for (const passId of compiled.order) {
    const item = retainedMap.get(passId);
    if (item === undefined) continue;
    const currentPass = item.pass;

    // Check 1: Command class (raster only).
    if (currentPass.passKind !== 'raster' || currentPass.rasterDetails === undefined) {
      if (activeGroup !== undefined) {
        const lastMember = activeGroup.members[activeGroup.members.length - 1]!;
        splitRecords.push(
          Object.freeze({
            predecessorPassId: lastMember.token.passId,
            candidatePassId: currentPass.token.passId,
            reason: SplitReasonCode.NonRasterBoundary
          })
        );
        flushActiveGroup();
      }
      continue;
    }

    // Optimization disabled check
    if (!normalizedOptions.enablePassFusion) {
      if (lastRasterPassId !== undefined) {
        splitRecords.push(
          Object.freeze({
            predecessorPassId: lastRasterPassId,
            candidatePassId: currentPass.token.passId,
            reason: SplitReasonCode.OptimizationDisabled
          })
        );
      }
      lastRasterPassId = currentPass.token.passId;
      activeGroup = createSingleActiveGroup(currentPass, snapshot);
      flushActiveGroup();
      continue;
    }
    lastRasterPassId = currentPass.token.passId;

    // If no active group, start singleton group
    if (activeGroup === undefined) {
      activeGroup = createSingleActiveGroup(currentPass, snapshot);
      continue;
    }

    counters.examinedCandidates++;

    const candidateSig = extractRasterSignature(currentPass, snapshot);
    const lastMember = activeGroup.members[activeGroup.members.length - 1]!;

    const evaluation = evaluateCandidateFusion(
      activeGroup,
      currentPass,
      candidateSig,
      snapshot,
      compiled,
      normalizedOptions,
      groups,
      counters
    );

    if (evaluation.splitReason === null) {
      activeGroup.members.push(currentPass);
      activeGroup.usageAccumulator.addPass(currentPass);
      if (evaluation.lateDepthSafe) {
        activeGroup.hasLateDepth = true;
        activeGroup.signature = Object.freeze({
          ...activeGroup.signature,
          depthStencil: candidateSig.depthStencil
        });
      }
      counters.fusedBoundariesCount++;
    } else {
      splitRecords.push(
        Object.freeze({
          predecessorPassId: lastMember.token.passId,
          candidatePassId: currentPass.token.passId,
          reason: evaluation.splitReason
        })
      );
      flushActiveGroup();
      activeGroup = createSingleActiveGroup(currentPass, snapshot);
    }
  }

  flushActiveGroup();

  const residency = summarizeFusionResidency(snapshot, compiled, groups);
  if (residency !== null) {
    counters.peakTransientBytes = residency.peakTransientBytes;
    counters.physicalLifetimeExpansionBytes = residency.physicalLifetimeExpansionBytes;
  }

  return Object.freeze({
    groups: Object.freeze(groups),
    splitRecords: Object.freeze(splitRecords),
    counters: Object.freeze(counters)
  });
}

function createSingleActiveGroup(
  pass: GraphPassDeclaration,
  snapshot: RenderGraphSnapshot
): ActiveRasterGroup {
  const signature = extractRasterSignature(pass, snapshot);
  const usageAccumulator = new GroupUsageAccumulator();
  usageAccumulator.addPass(pass);
  return {
    members: [pass],
    signature,
    usageAccumulator,
    hasLateDepth: false
  };
}

function lowerRasterGroupPlan(
  activeGroup: ActiveRasterGroup,
  groupIndex: number,
  snapshot: RenderGraphSnapshot,
  compiled: CompiledRenderGraph,
  retainedMap: ReadonlyMap<number, { pass: GraphPassDeclaration; idx: number }>
): RasterGroupPlan {
  const members = Object.freeze([...activeGroup.members]);
  const passIds = Object.freeze(members.map((m) => m.token.passId));
  const retainedIndices = Object.freeze(members.map((m) => retainedMap.get(m.token.passId)!.idx));
  const attachments = lowerPhysicalAttachmentOperations(
    members,
    snapshot,
    compiled,
    activeGroup.hasLateDepth
  );
  const usageScope = activeGroup.usageAccumulator.freeze();
  const boundaryStates = Object.freeze(
    retainedIndices.map((retainedPassIndex, i) =>
      Object.freeze({ passId: passIds[i]!, retainedPassIndex })
    )
  );

  return Object.freeze({
    groupIndex,
    retainedPassIndices: retainedIndices,
    passIds,
    attachments,
    usageScope,
    boundaryStates
  });
}
