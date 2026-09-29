import { mergeAssetRequestDemands, planAssetStageAdmission } from './admission';
import { AssetRequestStage } from './constants';
import { DEFAULT_ASSET_RETRY_POLICY, planAssetRetry } from './retry-policy';
import { AssetRequestStageFailure } from './stage-failure';
import { assertAssetUploadDeferral } from './upload-deferral';
import type {
  AssetPrioritySignals,
  AssetRequestRetrySnapshot,
  AssetRequestSchedulerOptions,
  AssetRequestDemand,
  AssetRequestKey,
  AssetRequestLease,
  AssetRequestLeaseStatus,
  AssetRequestSchedulerSnapshot,
  AssetRetryPolicy,
  AssetRequestStage as AssetRequestStageType,
  AssetSchedulerBudget,
  AssetStageAdmissionPlan,
  AssetStageExecutionResult,
  AssetStageExecutor,
  AssetUploadDeferral,
  MergedAssetRequestDemand
} from './types';

/**
 * Owns independent consumer leases over deduplicated pending asset operations.
 *
 * This scheduler owns admission and typed retry timing only. Transport, decoding, upload execution,
 * publication, and residency remain authority-owned integrations.
 */
export class AssetRequestScheduler {
  private readonly leases = new Map<string, MutableLease>();
  private readonly operations = new Map<AssetRequestKey, Map<string, AssetRequestDemand>>();
  private readonly deferredExecutors = new Map<
    AssetRequestKey,
    Readonly<{ request: MergedAssetRequestDemand; executor: AssetStageExecutor }>
  >();
  private readonly inFlight = new Set<AssetRequestKey>();

  private readonly retryStates = new Map<AssetRequestKey, RetryState>();

  private readonly retryAttempts = new Map<AssetRequestKey, number>();

  private readonly retryPolicy: AssetRetryPolicy;

  private readonly nowMilliseconds: () => number;

  private nextLeaseId = 1;
  private currentRevision = 0;

  /** Creates a scheduler with injectable time and deterministic retry bounds. */
  constructor(options: AssetRequestSchedulerOptions = {}) {
    this.retryPolicy = options.retryPolicy ?? DEFAULT_ASSET_RETRY_POLICY;
    this.nowMilliseconds = options.nowMilliseconds ?? Date.now;
  }

  /** Registers one independently cancellable consumer demand. */
  request(demand: AssetRequestDemand): AssetRequestLease {
    const id = `asset-request-lease:${this.nextLeaseId++}`;
    const operation = this.operations.get(demand.key) ?? new Map<string, AssetRequestDemand>();
    if (operation.size > 0) validateCompatibleOperation(demand, operation.values().next().value);
    const leaseDemand = Object.freeze({ ...demand, consumerId: id });
    operation.set(id, leaseDemand);
    this.operations.set(demand.key, operation);
    const lease: MutableLease = {
      id,
      key: demand.key,
      status: 'active',
      demand: leaseDemand
    };
    this.leases.set(id, lease);
    this.currentRevision += 1;
    return Object.freeze({
      id,
      key: demand.key,
      get status() {
        return lease.status;
      },
      get cancelled() {
        return lease.status === 'cancelled';
      },
      updatePriority: (priority: AssetPrioritySignals) => this.updatePriority(lease, priority),
      cancel: (reason: string) => this.cancel(lease, reason)
    });
  }

  /** Returns a detached immutable view of all pending merged operations. */
  snapshot(): AssetRequestSchedulerSnapshot {
    const operations = this.mergedOperations();
    let completedLeases = 0;
    for (const lease of this.leases.values()) {
      if (lease.status === 'completed') completedLeases += 1;
    }
    return Object.freeze({
      revision: this.currentRevision,
      operations,
      activeLeases: this.activeLeaseCount(),
      completedLeases,
      retries: this.retrySnapshots()
    });
  }

  /** Plans one stage using the current active consumer leases without retaining caller data. */
  plan(stage: AssetRequestStageType, budget: AssetSchedulerBudget): AssetStageAdmissionPlan {
    const now = this.readNowMilliseconds();
    const demands = this.activeDemandsForStage(stage).filter((demand) => {
      const retry = this.retryStates.get(demand.key);
      return retry === undefined || (retry.kind === 'backoff' && retry.retryAtMilliseconds <= now);
    });
    return planAssetStageAdmission(stage, demands, budget);
  }

  /**
   * Runs admitted operations through an injected stage authority, then revalidates before state
   * transition. Execution is sequential inside this bounded admission plan, so this seam cannot
   * create an unbounded Promise fan-out.
   */
  async execute(
    stage: AssetRequestStageType,
    budget: AssetSchedulerBudget,
    executor: AssetStageExecutor
  ): Promise<readonly AssetStageExecutionResult[]> {
    const plan = this.plan(stage, budget);
    const results: AssetStageExecutionResult[] = [];
    for (const request of plan.admitted) {
      if (this.inFlight.has(request.key)) {
        results.push(
          Object.freeze({
            key: request.key,
            stage,
            status: 'failed',
            error: new Error(`Asset request "${request.key}" is already executing.`)
          })
        );
        continue;
      }
      const retained = this.deferredExecutors.get(request.key);
      if (retained !== undefined && retained.executor !== executor) {
        results.push(
          Object.freeze({
            key: request.key,
            stage,
            status: 'failed',
            error: new Error(
              `Deferred asset operation "${request.key}" requires its original executor.`
            )
          })
        );
        continue;
      }
      this.inFlight.add(request.key);
      try {
        const execution = await executor.execute(request);
        if (execution !== undefined) {
          assertUploadDeferral(stage, execution);
          const result = this.settleDeferral(request, execution);
          if (result.status === 'deferred' && executor.discard !== undefined) {
            this.deferredExecutors.set(request.key, { request, executor });
          } else if (result.status === 'stale') {
            this.deferredExecutors.delete(request.key);
            executor.discard?.(request);
          }
          results.push(result);
          continue;
        }
      } catch (error) {
        this.deferredExecutors.delete(request.key);
        results.push(this.settleFailure(request, error));
        continue;
      } finally {
        this.inFlight.delete(request.key);
      }
      this.deferredExecutors.delete(request.key);
      try {
        const result = this.settleExecution(request, executor);
        if (result.status === 'advanced' || result.status === 'completed') {
          this.retryStates.delete(request.key);
          this.retryAttempts.delete(request.key);
        }
        if (result.status === 'stale') executor.discard?.(request);
        results.push(result);
      } catch (error) {
        executor.discard?.(request);
        results.push(this.settleFailure(request, error));
      }
    }
    return Object.freeze(results);
  }

  /**
   * Advances one pending operation after its current stage executor has completed successfully.
   *
   * @throws When the operation is absent, has no consumers, or the transition skips the declared
   * scheduler stage order.
   */
  advance(key: AssetRequestKey, nextStage: AssetRequestStageType): void {
    const operation = this.operations.get(key);
    const first = operation?.values().next().value as AssetRequestDemand | undefined;
    if (operation === undefined || first === undefined)
      throw new Error(`Asset request operation "${key}" is not pending.`);
    const expected = NEXT_STAGE[first.stage];
    if (expected !== nextStage) {
      throw new Error(
        `Asset request operation "${key}" must advance from "${first.stage}" to "${expected ?? 'terminal'}".`
      );
    }
    for (const [leaseId, demand] of operation) {
      const advanced = Object.freeze({ ...demand, stage: nextStage });
      operation.set(leaseId, advanced);
      const lease = this.leases.get(leaseId);
      if (lease === undefined) throw new Error('Asset request operation retained a missing lease.');
      lease.demand = advanced;
    }
    this.currentRevision += 1;
  }

  private settleDeferral(
    request: MergedAssetRequestDemand,
    deferral: AssetUploadDeferral
  ): AssetStageExecutionResult {
    if (!this.isCurrentExecution(request)) {
      return Object.freeze({ key: request.key, stage: request.stage, status: 'stale' });
    }
    return Object.freeze({
      key: request.key,
      stage: request.stage,
      status: 'deferred',
      reason: deferral.reason
    });
  }

  private settleExecution(
    request: MergedAssetRequestDemand,
    executor: AssetStageExecutor
  ): AssetStageExecutionResult {
    const { key, stage } = request;
    if (!this.isCurrentExecution(request)) {
      return Object.freeze({ key, stage, status: 'stale' });
    }
    const operation = this.operations.get(key)!;
    if (stage === AssetRequestStage.Upload) {
      for (const leaseId of operation.keys()) {
        const lease = this.leases.get(leaseId);
        if (lease === undefined || lease.status !== 'active') {
          return Object.freeze({ key, stage, status: 'stale' });
        }
      }
      // Authority publication is synchronous: no cancellation can interleave between validation
      // and the lease transition, and a failed publish leaves the operation retryable.
      executor.commit?.(request);
      this.operations.delete(key);
      for (const leaseId of operation.keys()) {
        const lease = this.leases.get(leaseId)!;
        lease.status = 'completed';
      }
      this.currentRevision += 1;
      return Object.freeze({ key, stage, status: 'completed' });
    }
    const nextStage = NEXT_STAGE[stage];
    if (nextStage === undefined) return Object.freeze({ key, stage, status: 'stale' });
    executor.commitStage?.(request);
    this.advance(key, nextStage);
    return Object.freeze({ key, stage, status: 'advanced' });
  }

  private isCurrentExecution(request: MergedAssetRequestDemand): boolean {
    const operation = this.operations.get(request.key);
    const first = operation?.values().next().value as AssetRequestDemand | undefined;
    return (
      operation !== undefined &&
      first !== undefined &&
      first.stage === request.stage &&
      first.revision === request.revision &&
      first.assetId === request.assetId &&
      request.consumerIds.some((consumerId) => operation.has(consumerId))
    );
  }

  private updatePriority(lease: MutableLease, priority: AssetPrioritySignals): void {
    this.assertLiveLease(lease, 'update priority');
    const operation = this.operations.get(lease.key);
    if (operation === undefined)
      throw new Error('Asset request operation is missing for a live lease.');
    const updated = Object.freeze({ ...lease.demand, priority: Object.freeze({ ...priority }) });
    operation.set(lease.id, updated);
    lease.demand = updated;
    this.currentRevision += 1;
  }

  private cancel(lease: MutableLease, reason: string): void {
    if (lease.status === 'cancelled') return;
    if (typeof reason !== 'string' || !reason.trim()) {
      throw new Error('Asset request cancellation reason must be non-empty.');
    }
    let discarded:
      | Readonly<{
          request: MergedAssetRequestDemand;
          executor: AssetStageExecutor;
        }>
      | undefined;
    if (lease.status === 'active') {
      const operation = this.operations.get(lease.key);
      if (operation === undefined)
        throw new Error('Asset request operation is missing for a live lease.');
      operation.delete(lease.id);
      if (operation.size === 0) {
        this.operations.delete(lease.key);
        discarded = this.deferredExecutors.get(lease.key);
        this.deferredExecutors.delete(lease.key);
      }
    }
    lease.status = 'cancelled';
    this.leases.delete(lease.id);
    this.currentRevision += 1;
    if (!this.operations.has(lease.key)) {
      this.retryStates.delete(lease.key);
      this.retryAttempts.delete(lease.key);
    }
    discarded?.executor.discard?.(discarded.request);
  }

  private activeDemandsForStage(stage: AssetRequestStageType): readonly AssetRequestDemand[] {
    const demands: AssetRequestDemand[] = [];
    for (const operation of this.operations.values()) {
      for (const demand of operation.values()) {
        if (demand.stage === stage) demands.push(demand);
      }
    }
    return Object.freeze(demands);
  }

  private settleFailure(
    request: MergedAssetRequestDemand,
    error: unknown
  ): AssetStageExecutionResult {
    if (!this.isCurrentExecution(request)) {
      return Object.freeze({ key: request.key, stage: request.stage, status: 'stale', error });
    }
    if (!(error instanceof AssetRequestStageFailure)) {
      return Object.freeze({ key: request.key, stage: request.stage, status: 'failed', error });
    }
    const attempt = (this.retryAttempts.get(request.key) ?? 0) + 1;
    const decision = planAssetRetry(
      {
        requestKey: request.key,
        failure: error.failure,
        completedAttempts: attempt,
        nowMilliseconds: this.readNowMilliseconds(),
        ...(error.retryAfterMilliseconds === undefined
          ? {}
          : { retryAfterMilliseconds: error.retryAfterMilliseconds })
      },
      this.retryPolicy
    );
    this.retryAttempts.set(request.key, attempt);
    if (decision.kind === 'retry') {
      this.retryStates.set(request.key, {
        kind: 'backoff',
        attempt,
        retryAtMilliseconds: decision.retryAtMilliseconds
      });
    } else {
      this.retryStates.set(request.key, {
        kind: 'stopped',
        attempt,
        failure: error.failure
      });
    }
    this.currentRevision += 1;
    return Object.freeze({
      key: request.key,
      stage: request.stage,
      status: 'failed',
      error,
      retry: decision
    });
  }

  private retrySnapshots(): readonly AssetRequestRetrySnapshot[] {
    return Object.freeze(
      [...this.retryStates.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, retry]) =>
          retry.kind === 'backoff'
            ? Object.freeze({
                key,
                kind: retry.kind,
                attempt: retry.attempt,
                retryAtMilliseconds: retry.retryAtMilliseconds
              })
            : Object.freeze({
                key,
                kind: retry.kind,
                attempt: retry.attempt,
                failure: retry.failure
              })
        )
    );
  }

  private readNowMilliseconds(): number {
    const now = this.nowMilliseconds();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error('Asset scheduler clock must return a non-negative safe integer.');
    }
    return now;
  }

  private mergedOperations(): readonly MergedAssetRequestDemand[] {
    const demands: AssetRequestDemand[] = [];
    for (const operation of this.operations.values()) demands.push(...operation.values());
    return mergeAssetRequestDemands(demands);
  }

  private assertLiveLease(lease: MutableLease, action: string): void {
    if (lease.status !== 'active' || !this.leases.has(lease.id)) {
      throw new Error(`Cannot ${action} for a cancelled asset request lease.`);
    }
  }

  private activeLeaseCount(): number {
    let active = 0;
    for (const lease of this.leases.values()) {
      if (lease.status === 'active') active += 1;
    }
    return active;
  }
}

const NEXT_STAGE: Readonly<Partial<Record<AssetRequestStageType, AssetRequestStageType>>> =
  Object.freeze({
    [AssetRequestStage.Metadata]: AssetRequestStage.Read,
    [AssetRequestStage.Read]: AssetRequestStage.Decode,
    [AssetRequestStage.Decode]: AssetRequestStage.Finalize,
    [AssetRequestStage.Finalize]: AssetRequestStage.Upload
  });

interface MutableLease {
  readonly id: string;
  readonly key: AssetRequestKey;
  status: AssetRequestLeaseStatus;
  demand: AssetRequestDemand;
}

type RetryState =
  | Readonly<{ kind: 'backoff'; attempt: number; retryAtMilliseconds: number }>
  | Readonly<{ kind: 'stopped'; attempt: number; failure: string }>;

function assertUploadDeferral(
  stage: AssetRequestStageType,
  result: unknown
): asserts result is AssetUploadDeferral {
  if (stage !== AssetRequestStage.Upload) {
    throw new Error('Only an upload-stage executor may defer admitted work.');
  }
  assertAssetUploadDeferral(result);
}

function validateCompatibleOperation(
  demand: AssetRequestDemand,
  existing: AssetRequestDemand | undefined
): void {
  if (existing === undefined) throw new Error('Asset request operation has no existing demand.');
  if (
    demand.assetId !== existing.assetId ||
    demand.stage !== existing.stage ||
    demand.revision !== existing.revision
  ) {
    throw new Error(
      `Asset request key "${demand.key}" does not describe one compatible operation.`
    );
  }
}
