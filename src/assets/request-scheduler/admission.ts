import { compareCodeUnits } from '../../core';
import { AssetRequestStage } from './constants';
import type {
  AssetPriorityClass,
  AssetPrioritySignals,
  AssetRequestDemand,
  AssetRequestDeferralReason,
  AssetRequestStage as AssetRequestStageType,
  AssetSchedulerBudget,
  AssetStageAdmissionPlan,
  DeferredAssetRequest,
  MergedAssetRequestDemand
} from './types';

const PRIORITY_RANK: Readonly<Record<AssetPriorityClass, number>> = Object.freeze({
  interactive: 3,
  visible: 2,
  prefetch: 1,
  background: 0
});

/**
 * Merges compatible consumer demands into one immutable scheduler operation.
 *
 * @throws When a caller attempts to merge distinct asset, stage, or revision identities under one
 * request key, or supplies invalid budget-relevant values.
 */
export function mergeAssetRequestDemands(
  demands: readonly AssetRequestDemand[]
): readonly MergedAssetRequestDemand[] {
  const merged = new Map<string, MutableMergedDemand>();
  for (const demand of demands) {
    validateDemand(demand);
    const current = merged.get(demand.key);
    if (current === undefined) {
      merged.set(demand.key, {
        key: demand.key,
        assetId: demand.assetId,
        stage: demand.stage,
        consumerIds: new Set([demand.consumerId]),
        priority: demand.priority,
        deadline: demand.deadline,
        estimated: demand.estimated,
        revision: demand.revision
      });
      continue;
    }
    if (
      current.assetId !== demand.assetId ||
      current.stage !== demand.stage ||
      current.revision !== demand.revision
    ) {
      throw new Error(
        `Asset request key "${demand.key}" does not describe one compatible operation.`
      );
    }
    current.consumerIds.add(demand.consumerId);
    current.priority = mergePriority(current.priority, demand.priority);
    current.deadline = earliestDeadline(current.deadline, demand.deadline);
    current.estimated = mergeCost(current.estimated, demand.estimated);
  }
  return Object.freeze(
    [...merged.values()].map((demand) =>
      Object.freeze({
        key: demand.key,
        assetId: demand.assetId,
        stage: demand.stage,
        consumerIds: Object.freeze([...demand.consumerIds].sort(compareCodeUnits)),
        priority: Object.freeze({ ...demand.priority }),
        ...(demand.deadline === undefined ? {} : { deadline: demand.deadline }),
        estimated: Object.freeze({ ...demand.estimated }),
        revision: demand.revision
      })
    )
  );
}

/**
 * Produces deterministic, hard-budget-respecting admission for a single stage.
 *
 * This function has no queue, network, worker, payload, or GPU side effects. Deferred entries are
 * not rejected: callers retain them for a later frame or a revised budget snapshot.
 *
 * @throws When a demand belongs to another stage or the budget is invalid.
 */
export function planAssetStageAdmission(
  stage: AssetRequestStageType,
  demands: readonly AssetRequestDemand[],
  budget: AssetSchedulerBudget
): AssetStageAdmissionPlan {
  validateBudget(budget);
  const merged = mergeAssetRequestDemands(demands);
  for (const demand of merged) {
    if (demand.stage !== stage) {
      throw new Error(
        `Asset request "${demand.key}" belongs to stage "${demand.stage}", not "${stage}".`
      );
    }
  }
  const ordered = [...merged].sort(compareMergedDemand);
  const admitted: MergedAssetRequestDemand[] = [];
  const deferred: DeferredAssetRequest[] = [];
  let inFlightBytes = 0;
  let finalizeMilliseconds = 0;
  let uploadBytes = 0;
  let uploadCommands = 0;
  for (const demand of ordered) {
    const reason = admissionDeferralReason(
      stage,
      demand,
      budget,
      admitted.length,
      inFlightBytes,
      finalizeMilliseconds,
      uploadBytes,
      uploadCommands
    );
    if (reason !== undefined) {
      deferred.push(Object.freeze({ request: demand, reason }));
      continue;
    }
    admitted.push(demand);
    inFlightBytes += demand.estimated.inFlightBytes;
    finalizeMilliseconds += demand.estimated.finalizeMilliseconds ?? 0;
    uploadBytes += demand.estimated.uploadBytes ?? 0;
    uploadCommands += demand.estimated.uploadCommands ?? 0;
  }
  const consumers = merged.reduce((total, demand) => total + demand.consumerIds.length, 0);
  return Object.freeze({
    stage,
    admitted: Object.freeze(admitted),
    deferred: Object.freeze(deferred),
    counters: Object.freeze({
      inputDemands: demands.length,
      mergedRequests: merged.length,
      duplicateConsumers: consumers - merged.length,
      admittedRequests: admitted.length,
      admittedInFlightBytes: inFlightBytes,
      admittedFinalizeMilliseconds: finalizeMilliseconds,
      admittedUploadBytes: uploadBytes,
      admittedUploadCommands: uploadCommands
    })
  });
}

interface MutableMergedDemand {
  readonly key: AssetRequestDemand['key'];
  readonly assetId: AssetRequestDemand['assetId'];
  readonly stage: AssetRequestStageType;
  readonly consumerIds: Set<string>;
  priority: AssetPrioritySignals;
  deadline: number | undefined;
  estimated: AssetRequestDemand['estimated'];
  readonly revision: number;
}

function admissionDeferralReason(
  stage: AssetRequestStageType,
  demand: MergedAssetRequestDemand,
  budget: AssetSchedulerBudget,
  admittedCount: number,
  inFlightBytes: number,
  finalizeMilliseconds: number,
  uploadBytes: number,
  uploadCommands: number
): AssetRequestDeferralReason | undefined {
  if (demand.estimated.inFlightBytes > budget.maxInFlightBytes[stage]) return 'request-too-large';
  if (
    stage === 'finalize' &&
    (demand.estimated.finalizeMilliseconds ?? 0) > budget.frameFinalizeMilliseconds
  )
    return 'request-too-large';
  if (stage === 'upload' && (demand.estimated.uploadBytes ?? 0) > budget.frameUploadBytes)
    return 'request-too-large';
  if (stage === 'upload' && (demand.estimated.uploadCommands ?? 0) > budget.frameUploadCommands)
    return 'request-too-large';
  if (admittedCount >= budget.maxRequests[stage]) return 'request-limit';
  if (inFlightBytes + demand.estimated.inFlightBytes > budget.maxInFlightBytes[stage])
    return 'in-flight-byte-limit';
  if (
    stage === 'finalize' &&
    finalizeMilliseconds + (demand.estimated.finalizeMilliseconds ?? 0) >
      budget.frameFinalizeMilliseconds
  )
    return 'finalize-time-limit';
  if (
    stage === 'upload' &&
    uploadBytes + (demand.estimated.uploadBytes ?? 0) > budget.frameUploadBytes
  )
    return 'upload-byte-limit';
  if (
    stage === 'upload' &&
    uploadCommands + (demand.estimated.uploadCommands ?? 0) > budget.frameUploadCommands
  )
    return 'upload-command-limit';
  return undefined;
}

function compareMergedDemand(
  left: MergedAssetRequestDemand,
  right: MergedAssetRequestDemand
): number {
  return (
    PRIORITY_RANK[right.priority.class] - PRIORITY_RANK[left.priority.class] ||
    left.priority.dependencyDepth - right.priority.dependencyDepth ||
    (right.priority.screenContribution ?? 0) - (left.priority.screenContribution ?? 0) ||
    (right.priority.geometricError ?? 0) - (left.priority.geometricError ?? 0) ||
    (left.deadline ?? Number.POSITIVE_INFINITY) - (right.deadline ?? Number.POSITIVE_INFINITY) ||
    right.priority.explicit - left.priority.explicit ||
    right.priority.age - left.priority.age ||
    left.priority.retryPenalty - right.priority.retryPenalty ||
    compareCodeUnits(left.key, right.key)
  );
}

function mergePriority(
  left: AssetPrioritySignals,
  right: AssetPrioritySignals
): AssetPrioritySignals {
  return {
    class: PRIORITY_RANK[left.class] >= PRIORITY_RANK[right.class] ? left.class : right.class,
    explicit: Math.max(left.explicit, right.explicit),
    screenContribution: Math.max(left.screenContribution ?? 0, right.screenContribution ?? 0),
    geometricError: Math.max(left.geometricError ?? 0, right.geometricError ?? 0),
    dependencyDepth: Math.min(left.dependencyDepth, right.dependencyDepth),
    age: Math.max(left.age, right.age),
    retryPenalty: Math.min(left.retryPenalty, right.retryPenalty)
  };
}

function mergeCost(
  left: AssetRequestDemand['estimated'],
  right: AssetRequestDemand['estimated']
): AssetRequestDemand['estimated'] {
  return {
    inFlightBytes: Math.max(left.inFlightBytes, right.inFlightBytes),
    finalizeMilliseconds: Math.max(left.finalizeMilliseconds ?? 0, right.finalizeMilliseconds ?? 0),
    uploadBytes: Math.max(left.uploadBytes ?? 0, right.uploadBytes ?? 0),
    uploadCommands: Math.max(left.uploadCommands ?? 0, right.uploadCommands ?? 0)
  };
}

function earliestDeadline(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function validateDemand(demand: AssetRequestDemand): void {
  if (!demand.key.trim()) throw new Error('Asset request key must be non-empty.');
  if (!demand.assetId.trim()) throw new Error('Asset request assetId must be non-empty.');
  if (!demand.consumerId.trim()) throw new Error('Asset request consumerId must be non-empty.');
  if (!Number.isSafeInteger(demand.revision) || demand.revision < 0)
    throw new Error('Asset request revision must be a non-negative safe integer.');
  validatePriority(demand.priority);
  validateCost(demand.estimated);
  if (demand.deadline !== undefined && (!Number.isFinite(demand.deadline) || demand.deadline < 0))
    throw new Error('Asset request deadline must be a non-negative finite number.');
}

function validatePriority(priority: AssetPrioritySignals): void {
  if (!Number.isFinite(priority.explicit))
    throw new Error('Asset request explicit priority must be finite.');
  for (const [name, value] of Object.entries({
    screenContribution: priority.screenContribution,
    geometricError: priority.geometricError,
    dependencyDepth: priority.dependencyDepth,
    age: priority.age,
    retryPenalty: priority.retryPenalty
  })) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`Asset request priority ${name} must be a non-negative finite number.`);
  }
}

function validateCost(cost: AssetRequestDemand['estimated']): void {
  for (const [name, value] of Object.entries(cost)) {
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`Asset request cost ${name} must be a non-negative finite number.`);
  }
}

function validateBudget(budget: AssetSchedulerBudget): void {
  for (const stage of Object.values(AssetRequestStage)) {
    const requests = budget.maxRequests[stage];
    const bytes = budget.maxInFlightBytes[stage];
    if (!Number.isSafeInteger(requests) || requests < 0)
      throw new Error(`Asset scheduler maxRequests.${stage} must be a non-negative safe integer.`);
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new Error(
        `Asset scheduler maxInFlightBytes.${stage} must be a non-negative safe integer.`
      );
  }
  for (const [name, value] of Object.entries({
    frameFinalizeMilliseconds: budget.frameFinalizeMilliseconds,
    frameUploadBytes: budget.frameUploadBytes,
    frameUploadCommands: budget.frameUploadCommands
  })) {
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`Asset scheduler ${name} must be a non-negative finite number.`);
  }
}
