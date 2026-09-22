import type { JobBudgetClass, JobScheduler, JobType } from '../../jobs';
import type { RHIDevice } from '../../rhi';
import type { VirtualFileSystem } from '../vfs';
import { AssetRequestStage } from './constants';
import type { AssetStageExecutor, MergedAssetRequestDemand } from './types';

/** Authority-owned recipe for one asset operation selected by a scheduler request key and revision. */
export interface AssetPipelineOperation {
  readonly uri: string;
  readonly decodeJob: JobType<Uint8Array, unknown>;
  readonly finalize: (decoded: unknown, request: MergedAssetRequestDemand) => unknown;
  readonly upload: (
    finalized: unknown,
    device: RHIDevice,
    request: MergedAssetRequestDemand
  ) => void | Promise<void>;
}

/** Resolves a scheduler operation to the VFS/Jobs/RHI recipe owned by Asset Runtime. */
export interface AssetPipelineOperationResolver {
  resolve(request: MergedAssetRequestDemand): AssetPipelineOperation | undefined;
}

/**
 * Version-isolated registration owned by Asset Runtime before it delegates work to the scheduler.
 *
 * A request key can acquire a new operation only at a new payload revision. The registry owns the
 * recipe snapshot, while VFS, JobScheduler, and RHI retain ownership of their side effects.
 */
export class AssetPipelineOperationRegistry implements AssetPipelineOperationResolver {
  private readonly operations = new Map<string, Map<number, AssetPipelineOperation>>();

  register(request: MergedAssetRequestDemand, operation: AssetPipelineOperation): void {
    validateOperation(operation);
    const byRevision =
      this.operations.get(request.key) ?? new Map<number, AssetPipelineOperation>();
    if (byRevision.has(request.revision)) {
      throw new Error(
        `Asset pipeline operation "${request.key}" revision ${request.revision} is already registered.`
      );
    }
    byRevision.set(request.revision, Object.freeze({ ...operation }));
    this.operations.set(request.key, byRevision);
  }

  resolve(request: MergedAssetRequestDemand): AssetPipelineOperation | undefined {
    return this.operations.get(request.key)?.get(request.revision);
  }
}

/** Compact observation surface for retained intermediate asset data. */
export interface AssetPipelineExecutorSnapshot {
  readonly pendingOperations: number;
  readonly retainedBytes: number;
}

interface PipelineState {
  readonly operation: AssetPipelineOperation;
  bytes?: Uint8Array;
  decoded?: unknown;
  finalized?: unknown;
}

/**
 * Executes AssetRequestScheduler stages through the existing VFS, JobScheduler, and RHI owners.
 *
 * It deliberately does not publish assets: the caller must publish only after the scheduler's
 * revision revalidation reports `completed`. Intermediate bytes and decoded values remain private
 * to this executor and are discarded after a successful upload.
 */
export class AssetPipelineExecutor implements AssetStageExecutor {
  private readonly states = new Map<string, PipelineState>();

  constructor(
    private readonly vfs: Pick<VirtualFileSystem, 'read'>,
    private readonly jobs: Pick<JobScheduler, 'schedule'>,
    private readonly device: RHIDevice,
    private readonly registry: AssetPipelineOperationResolver
  ) {}

  async execute(request: MergedAssetRequestDemand): Promise<void> {
    try {
      switch (request.stage) {
        case AssetRequestStage.Metadata:
          this.metadata(request);
          return;
        case AssetRequestStage.Read:
          await this.read(request);
          return;
        case AssetRequestStage.Decode:
          await this.decode(request);
          return;
        case AssetRequestStage.Finalize:
          this.finalize(request);
          return;
        case AssetRequestStage.Upload:
          await this.upload(request);
          return;
      }
    } catch (error) {
      // Failed/cancelled stage work must not retain bytes until an unrelated retry happens.
      this.states.delete(operationIdentity(request));
      throw error;
    }
  }

  snapshot(): AssetPipelineExecutorSnapshot {
    let retainedBytes = 0;
    for (const state of this.states.values()) retainedBytes += state.bytes?.byteLength ?? 0;
    return Object.freeze({ pendingOperations: this.states.size, retainedBytes });
  }

  private metadata(request: MergedAssetRequestDemand): void {
    this.stateFor(request);
  }

  private async read(request: MergedAssetRequestDemand): Promise<void> {
    const state = this.stateFor(request);
    const result = await this.vfs.read({ uri: state.operation.uri });
    if (result.kind !== 'success') {
      throw new Error(`Asset pipeline read for "${request.key}" failed: ${result.kind}.`);
    }
    state.bytes = new Uint8Array(result.bytes);
  }

  private async decode(request: MergedAssetRequestDemand): Promise<void> {
    const state = this.stateFor(request);
    const bytes = state.bytes;
    if (bytes === undefined) throw new Error(`Asset pipeline "${request.key}" has no read bytes.`);
    const handle = this.jobs.schedule(state.operation.decodeJob, {
      input: bytes.slice(),
      priority: request.priority.explicit,
      budgetClass: jobBudgetClass(request),
      ...(request.deadline === undefined ? {} : { deadlineMs: request.deadline }),
      ...(request.priority.screenContribution === undefined
        ? {}
        : { screenSpaceError: request.priority.screenContribution })
    });
    const result = await handle.result;
    if (result.status === 'completed') {
      state.decoded = result.output;
      return;
    }
    if (result.status === 'cancelled') {
      throw new Error(
        `Asset pipeline decode for "${request.key}" was cancelled: ${result.reason}.`
      );
    }
    throw new Error(
      `Asset pipeline decode for "${request.key}" failed: ${result.diagnostic.message}.`
    );
  }

  private finalize(request: MergedAssetRequestDemand): void {
    const state = this.stateFor(request);
    if (state.decoded === undefined)
      throw new Error(`Asset pipeline "${request.key}" has no decoded value.`);
    state.finalized = state.operation.finalize(state.decoded, request);
  }

  private async upload(request: MergedAssetRequestDemand): Promise<void> {
    const state = this.stateFor(request);
    if (state.finalized === undefined) {
      throw new Error(`Asset pipeline "${request.key}" has no finalized value.`);
    }
    await state.operation.upload(state.finalized, this.device, request);
    this.states.delete(operationIdentity(request));
  }

  private stateFor(request: MergedAssetRequestDemand): PipelineState {
    const identity = operationIdentity(request);
    const current = this.states.get(identity);
    if (current !== undefined) return current;
    const operation = this.registry.resolve(request);
    if (operation === undefined) {
      throw new Error(
        `Asset pipeline operation "${request.key}" revision ${request.revision} is unavailable.`
      );
    }
    const state: PipelineState = { operation };
    this.states.set(identity, state);
    return state;
  }
}

function operationIdentity(request: MergedAssetRequestDemand): string {
  return `${request.key}\u0000${request.revision}`;
}

function jobBudgetClass(request: MergedAssetRequestDemand): JobBudgetClass {
  if (request.priority.class === 'interactive') return 'interactive';
  if (request.priority.class === 'background') return 'background';
  return 'streaming';
}

function validateOperation(operation: AssetPipelineOperation): void {
  if (typeof operation.uri !== 'string' || !operation.uri.trim()) {
    throw new Error('Asset pipeline operation URI must be non-empty.');
  }
  if (operation.decodeJob === undefined || typeof operation.decodeJob.id !== 'string') {
    throw new Error('Asset pipeline operation requires a registered decode job type.');
  }
  if (typeof operation.finalize !== 'function' || typeof operation.upload !== 'function') {
    throw new Error('Asset pipeline operation requires finalize and upload functions.');
  }
}
