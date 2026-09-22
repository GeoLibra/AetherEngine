import { mergeAssetRequestDemands, planAssetStageAdmission } from './admission';
import { AssetRequestStage } from './constants';
import type {
  AssetPrioritySignals,
  AssetRequestDemand,
  AssetRequestKey,
  AssetRequestLease,
  AssetRequestLeaseStatus,
  AssetRequestSchedulerSnapshot,
  AssetRequestStage as AssetRequestStageType,
  AssetSchedulerBudget,
  AssetStageAdmissionPlan,
  AssetStageExecutionResult,
  AssetStageExecutor,
  MergedAssetRequestDemand
} from './types';

/**
 * Owns independent consumer leases over deduplicated pending asset operations.
 *
 * This scheduler intentionally owns admission facts only. Transport, decoding, upload execution,
 * publication, retries, and residency remain authority-owned integrations.
 */
export class AssetRequestScheduler {
  private readonly leases = new Map<string, MutableLease>();
  private readonly operations = new Map<AssetRequestKey, Map<string, AssetRequestDemand>>();
  private nextLeaseId = 1;
  private currentRevision = 0;

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
      completedLeases
    });
  }

  /** Plans one stage using the current active consumer leases without retaining caller data. */
  plan(stage: AssetRequestStageType, budget: AssetSchedulerBudget): AssetStageAdmissionPlan {
    const demands = this.activeDemandsForStage(stage);
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
      try {
        await executor.execute(request);
      } catch (error) {
        results.push(Object.freeze({ key: request.key, stage, status: 'failed', error }));
        continue;
      }
      results.push(this.settleExecution(request.key, stage));
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

  private settleExecution(
    key: AssetRequestKey,
    stage: AssetRequestStageType
  ): AssetStageExecutionResult {
    const operation = this.operations.get(key);
    const first = operation?.values().next().value as AssetRequestDemand | undefined;
    if (operation === undefined || first === undefined || first.stage !== stage) {
      return Object.freeze({ key, stage, status: 'stale' });
    }
    if (stage === AssetRequestStage.Upload) {
      this.operations.delete(key);
      for (const leaseId of operation.keys()) {
        const lease = this.leases.get(leaseId);
        if (lease === undefined || lease.status !== 'active') {
          return Object.freeze({ key, stage, status: 'stale' });
        }
        lease.status = 'completed';
      }
      this.currentRevision += 1;
      return Object.freeze({ key, stage, status: 'completed' });
    }
    const nextStage = NEXT_STAGE[stage];
    if (nextStage === undefined) return Object.freeze({ key, stage, status: 'stale' });
    this.advance(key, nextStage);
    return Object.freeze({ key, stage, status: 'advanced' });
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
    if (lease.status === 'active') {
      const operation = this.operations.get(lease.key);
      if (operation === undefined)
        throw new Error('Asset request operation is missing for a live lease.');
      operation.delete(lease.id);
      if (operation.size === 0) this.operations.delete(lease.key);
    }
    lease.status = 'cancelled';
    this.leases.delete(lease.id);
    this.currentRevision += 1;
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
