import type { GraphPassDeclaration, RenderGraphSnapshot } from '../../builder/builder';
import type { CompiledRenderGraph, TextureDescriptor } from '../../types';
import { SplitReasonCode } from './constants';
import { lowerPhysicalAttachmentOperations } from './operations';
import {
  compareColorSignatures,
  compareExistingDepthSignatures,
  extractRasterSignature,
  type RasterPassSignature
} from './signature';
import type {
  BoundarySplitRecord,
  GroupPartitionResult,
  NormalizedFusionOptions,
  PassFusionOptions,
  RasterGroupPlan
} from '../../types';
import { GroupUsageAccumulator } from './usage';
import { evaluateResidencyBudget } from './residency';

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

interface ActiveRasterGroup {
  members: GraphPassDeclaration[];
  signature: RasterPassSignature;
  usageAccumulator: GroupUsageAccumulator;
  hasLateDepth: boolean;
}

interface MutableFusionCounters {
  retainedLogicalRasterPasses: number;
  physicalRasterGroups: number;
  fusedBoundariesCount: number;
  examinedCandidates: number;
  usageComparisons: number;
  stateRestorationCommands: number;
  physicalLifetimeExpansionBytes: number;
  peakTransientBytes: number;
}

/**
 * Deterministically partitions consecutive retained raster passes into physical groups
 * evaluating the 10 compatibility criteria, safe late depth proof, and residency budget.
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

  function flushActiveGroup(): void {
    if (activeGroup === undefined) return;
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

    const groupPlan: RasterGroupPlan = Object.freeze({
      groupIndex: groups.length,
      retainedPassIndices: retainedIndices,
      passIds,
      attachments,
      usageScope,
      boundaryStates
    });

    groups.push(groupPlan);
    counters.physicalRasterGroups++;
    activeGroup = undefined;
  }

  let lastRasterPassId: number | undefined;

  for (const passId of compiled.order) {
    const item = retainedMap.get(passId);
    if (item === undefined) continue;
    const currentPass = item.pass;

    // Check 1: Command class (raster only)
    if (currentPass.passKind !== 'raster' || currentPass.rasterDetails === undefined) {
      if (activeGroup !== undefined) {
        const lastMember = activeGroup.members[activeGroup.members.length - 1]!;
        const splitReason =
          currentPass.passKind === 'compute' || currentPass.passKind === 'copy'
            ? SplitReasonCode.NonRasterBoundary
            : SplitReasonCode.LegacyOpaque;
        splitRecords.push(
          Object.freeze({
            predecessorPassId: lastMember.token.passId,
            candidatePassId: currentPass.token.passId,
            reason: splitReason
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
      // Emit singleton group
      const signature = extractRasterSignature(currentPass, snapshot);
      const usageAccumulator = new GroupUsageAccumulator();
      usageAccumulator.addPass(currentPass);
      activeGroup = {
        members: [currentPass],
        signature,
        usageAccumulator,
        hasLateDepth: false
      };
      flushActiveGroup();
      continue;
    }
    lastRasterPassId = currentPass.token.passId;

    // If no active group, start singleton group
    if (activeGroup === undefined) {
      const signature = extractRasterSignature(currentPass, snapshot);
      const usageAccumulator = new GroupUsageAccumulator();
      usageAccumulator.addPass(currentPass);
      activeGroup = {
        members: [currentPass],
        signature,
        usageAccumulator,
        hasLateDepth: false
      };
      continue;
    }

    counters.examinedCandidates++;

    // Evaluate candidate against accumulated active group in fixed check order
    const candidateSig = extractRasterSignature(currentPass, snapshot);
    const lastMember = activeGroup.members[activeGroup.members.length - 1]!;

    let splitReason: SplitReasonCode | null = null;
    let lateDepthSafe = false;

    // 1. Group pass limit
    if (
      normalizedOptions.maxGroupPassCount !== 'unlimited' &&
      activeGroup.members.length + 1 > normalizedOptions.maxGroupPassCount
    ) {
      splitReason = SplitReasonCode.GroupPassLimit;
    }

    // 2. Color attachments compatibility
    if (splitReason === null) {
      splitReason = compareColorSignatures(activeGroup.signature, candidateSig);
    }

    // 3. Initial operations check (intervening clear requires boundary)
    if (splitReason === null) {
      for (const color of currentPass.rasterDetails.colorAttachments) {
        if (color.options.load === 'clear') {
          splitReason = SplitReasonCode.IntermediateClear;
          break;
        }
      }
      if (
        splitReason === null &&
        activeGroup.signature.depthStencil !== undefined &&
        candidateSig.depthStencil !== undefined
      ) {
        if (currentPass.rasterDetails.depthStencilAttachment?.options.depthLoad === 'clear') {
          splitReason = SplitReasonCode.IntermediateClear;
        }
      }
    }

    // 4. Resolve boundary (no intermediate resolve)
    if (splitReason === null) {
      for (const m of activeGroup.members) {
        if (m.rasterDetails!.resolveAttachments.length > 0) {
          splitReason = SplitReasonCode.ResolveBoundary;
          break;
        }
      }
    }

    // 5. Depth/stencil compatibility and Safe Late Depth Introduction
    if (splitReason === null) {
      const accDepth = activeGroup.signature.depthStencil;
      const candDepth = candidateSig.depthStencil;

      if (accDepth !== undefined && candDepth !== undefined) {
        splitReason = compareExistingDepthSignatures(accDepth, candDepth);
      } else if (accDepth !== undefined && candDepth === undefined) {
        // Absent trailing depth without explicit proof
        splitReason = SplitReasonCode.DepthIntroductionUnproven;
      } else if (accDepth === undefined && candDepth !== undefined) {
        // Safe late depth introduction proof
        const candDepthAttachment = currentPass.rasterDetails.depthStencilAttachment!;
        const clearsDepth = candDepthAttachment.options.depthLoad === 'clear';
        const depthResourceId = candDepth.resourceId;

        // Condition 1: Candidate must clear depth
        if (!clearsDepth) {
          splitReason = SplitReasonCode.DepthIntroductionUnproven;
        } else {
          // Condition 2: No earlier member accesses the depth resource in any role
          let depthAccessedEarlier = false;
          for (const m of activeGroup.members) {
            for (const access of m.accesses) {
              if (access.handle.resourceId === depthResourceId) {
                depthAccessedEarlier = true;
                break;
              }
            }
            if (depthAccessedEarlier) break;
          }

          if (depthAccessedEarlier) {
            splitReason = SplitReasonCode.DepthIntroductionUnproven;
          } else {
            lateDepthSafe = true;
          }
        }
      }
    }

    // 6. Usage scope check
    if (splitReason === null) {
      counters.usageComparisons++;
      if (activeGroup.usageAccumulator.hasUsageConflictWith(currentPass)) {
        splitReason = SplitReasonCode.UsageScopeConflict;
      }
    }

    // 7. Residency budget
    if (splitReason === null && normalizedOptions.maxResidencyExpansionBytes !== 'unlimited') {
      const budgetResult = evaluateResidencyBudget(
        activeGroup.members,
        currentPass,
        snapshot,
        compiled,
        normalizedOptions.maxResidencyExpansionBytes,
        groups.map((group) =>
          group.retainedPassIndices.map((index) => compiled.retainedPasses[index]!)
        )
      );
      if (budgetResult !== null) {
        splitReason = budgetResult;
      }
    }

    if (splitReason === null) {
      // Accepted! Commit candidate to active group
      activeGroup.members.push(currentPass);
      activeGroup.usageAccumulator.addPass(currentPass);
      if (lateDepthSafe) {
        activeGroup.hasLateDepth = true;
        activeGroup.signature = Object.freeze({
          ...activeGroup.signature,
          depthStencil: candidateSig.depthStencil
        });
      }
      counters.fusedBoundariesCount++;
    } else {
      // Split boundary
      splitRecords.push(
        Object.freeze({
          predecessorPassId: lastMember.token.passId,
          candidatePassId: currentPass.token.passId,
          reason: splitReason
        })
      );
      flushActiveGroup();

      const signature = extractRasterSignature(currentPass, snapshot);
      const usageAccumulator = new GroupUsageAccumulator();
      usageAccumulator.addPass(currentPass);
      activeGroup = {
        members: [currentPass],
        signature,
        usageAccumulator,
        hasLateDepth: false
      };
    }
  }

  flushActiveGroup();

  return Object.freeze({
    groups: Object.freeze(groups),
    splitRecords: Object.freeze(splitRecords),
    counters: Object.freeze(counters)
  });
}
