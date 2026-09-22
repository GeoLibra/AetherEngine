import type { AssetId } from '../../types';

/** Canonical identity for one deduplicated asset request operation. */
export type AssetRequestKey = string & { readonly __assetRequestKey: unique symbol };

/** Scheduler-controlled lifecycle stage. */
export type AssetRequestStage =
  (typeof import('../constants').AssetRequestStage)[keyof typeof import('../constants').AssetRequestStage];

/** User-visible urgency class, ordered from interactive to background. */
export type AssetPriorityClass = 'interactive' | 'visible' | 'prefetch' | 'background';

/** Immutable priority inputs for one consumer demand. */
export interface AssetPrioritySignals {
  readonly class: AssetPriorityClass;
  readonly explicit: number;
  readonly screenContribution?: number;
  readonly geometricError?: number;
  readonly dependencyDepth: number;
  readonly age: number;
  readonly retryPenalty: number;
}

/** Estimated work admitted against a single scheduler stage. */
export interface AssetRequestCost {
  readonly inFlightBytes: number;
  readonly finalizeMilliseconds?: number;
  readonly uploadBytes?: number;
  readonly uploadCommands?: number;
}

/** One caller-owned request demand before scheduler deduplication. */
export interface AssetRequestDemand {
  readonly key: AssetRequestKey;
  readonly assetId: AssetId;
  readonly stage: AssetRequestStage;
  readonly consumerId: string;
  readonly priority: AssetPrioritySignals;
  readonly deadline?: number;
  readonly estimated: AssetRequestCost;
  readonly revision: number;
}

/** Per-stage concurrency and in-flight-byte ceilings. */
export interface AssetSchedulerBudget {
  readonly maxRequests: Readonly<Record<AssetRequestStage, number>>;
  readonly maxInFlightBytes: Readonly<Record<AssetRequestStage, number>>;
  readonly frameFinalizeMilliseconds: number;
  readonly frameUploadBytes: number;
  readonly frameUploadCommands: number;
}

/** A merged operation retaining all independent consumer identities. */
export interface MergedAssetRequestDemand {
  readonly key: AssetRequestKey;
  readonly assetId: AssetId;
  readonly stage: AssetRequestStage;
  readonly consumerIds: readonly string[];
  readonly priority: AssetPrioritySignals;
  readonly deadline?: number;
  readonly estimated: AssetRequestCost;
  readonly revision: number;
}

/** Explicit reason an otherwise valid demand was not admitted this frame. */
export type AssetRequestDeferralReason =
  | 'request-too-large'
  | 'request-limit'
  | 'in-flight-byte-limit'
  | 'finalize-time-limit'
  | 'upload-byte-limit'
  | 'upload-command-limit';

/** Deferred work retains its merged identity and a deterministic explanatory reason. */
export interface DeferredAssetRequest {
  readonly request: MergedAssetRequestDemand;
  readonly reason: AssetRequestDeferralReason;
}

/** Immutable budget-admission result for one stage and one frame. */
export interface AssetStageAdmissionPlan {
  readonly stage: AssetRequestStage;
  readonly admitted: readonly MergedAssetRequestDemand[];
  readonly deferred: readonly DeferredAssetRequest[];
  readonly counters: Readonly<{
    inputDemands: number;
    mergedRequests: number;
    duplicateConsumers: number;
    admittedRequests: number;
    admittedInFlightBytes: number;
    admittedFinalizeMilliseconds: number;
    admittedUploadBytes: number;
    admittedUploadCommands: number;
  }>;
}

/** One independent consumer lease over a scheduler-owned merged operation. */
export interface AssetRequestLease {
  readonly id: string;
  readonly key: AssetRequestKey;
  readonly status: AssetRequestLeaseStatus;
  readonly cancelled: boolean;
  updatePriority(priority: AssetPrioritySignals): void;
  cancel(reason: string): void;
}

/** Lifecycle state of one consumer lease. */
export type AssetRequestLeaseStatus = 'active' | 'completed' | 'cancelled';

/** Injected authority-owned execution of one already-admitted stage operation. */
export interface AssetStageExecutor {
  execute(request: MergedAssetRequestDemand): void | Promise<void>;
}

/** One executor result after the scheduler revalidates the operation boundary. */
export interface AssetStageExecutionResult {
  readonly key: AssetRequestKey;
  readonly stage: AssetRequestStage;
  readonly status: 'advanced' | 'completed' | 'stale' | 'failed';
  readonly error?: unknown;
}

/** Immutable scheduler-owned pending-operation snapshot for inspection and admission. */
export interface AssetRequestSchedulerSnapshot {
  readonly revision: number;
  readonly operations: readonly MergedAssetRequestDemand[];
  readonly activeLeases: number;
  readonly completedLeases: number;
}
