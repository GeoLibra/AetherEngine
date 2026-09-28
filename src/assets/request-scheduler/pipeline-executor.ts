import type { JobBudgetClass, JobScheduler, JobType } from '../../jobs';
import type { RHIDevice } from '../../rhi';
import type { VirtualFileSystem } from '../vfs';
import { AssetRequestStage } from './constants';
import type { AssetStageExecutor, AssetUploadDeferral, MergedAssetRequestDemand } from './types';
import { assertAssetUploadDeferral } from './upload-deferral';

/** Authority-owned recipe for one asset operation selected by a scheduler request key and revision. */
export interface AssetPipelineOperation {
  readonly uri: string;
  readonly decodeJob: JobType<Uint8Array, unknown>;
  readonly finalize: (decoded: unknown, request: MergedAssetRequestDemand) => unknown;
  /** Publishes the validated canonical CPU payload at the scheduler's finalize commit boundary. */
  readonly publishCpuPayload?: (
    decoded: unknown,
    finalized: unknown,
    request: MergedAssetRequestDemand
  ) => void;
  /** Uploads finalized data, or defers before any upload side effect when staging admission fails. */
  readonly upload: (
    finalized: unknown,
    device: RHIDevice,
    request: MergedAssetRequestDemand
  ) =>
    | void
    | AssetUploadDeferral
    | AssetPipelineUploadCandidate
    | Promise<void | AssetUploadDeferral | AssetPipelineUploadCandidate>;
}

/** An unpublished upload result whose ownership transfers only at the scheduler commit boundary. */
export interface AssetPipelineUploadCandidate {
  readonly status: 'staged';
  /** Atomically publish into the owning asset/prepared-variant registry. */
  commit(): void;
  /** Idempotently dispose unpublished physical resources after cancellation or failed commit. */
  discard(): void;
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
  candidate?: AssetPipelineUploadCandidate;
}

/**
 * Executes AssetRequestScheduler stages through the existing VFS, JobScheduler, and RHI owners.
 *
 * It deliberately does not publish assets: the caller must publish only after the scheduler's
 * revision revalidation reports `completed`. Intermediate bytes and decoded values remain private
 * to this executor across upload deferral and are discarded after success, failure, or the final
 * consumer's cancellation notification.
 */
export class AssetPipelineExecutor implements AssetStageExecutor {
  private readonly states = new Map<string, PipelineState>();

  constructor(
    private readonly vfs: Pick<VirtualFileSystem, 'read'>,
    private readonly jobs: Pick<JobScheduler, 'schedule'>,
    private readonly device: RHIDevice,
    private readonly registry: AssetPipelineOperationResolver
  ) {}

  async execute(request: MergedAssetRequestDemand): Promise<void | AssetUploadDeferral> {
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
          return await this.upload(request);
      }
    } catch (error) {
      // Failed/cancelled stage work must not retain bytes until an unrelated retry happens.
      this.discard(request);
      throw error;
    }
  }

  snapshot(): AssetPipelineExecutorSnapshot {
    let retainedBytes = 0;
    for (const state of this.states.values()) retainedBytes += state.bytes?.byteLength ?? 0;
    return Object.freeze({ pendingOperations: this.states.size, retainedBytes });
  }

  /** Releases retained read/decode/finalize data for an abandoned deferred operation. */
  discard(request: MergedAssetRequestDemand): void {
    const identity = operationIdentity(request);
    const state = this.states.get(identity);
    this.states.delete(identity);
    state?.candidate?.discard();
  }

  /** Publishes only the candidate whose revision has survived scheduler revalidation. */
  commit(request: MergedAssetRequestDemand): void {
    const identity = operationIdentity(request);
    const state = this.states.get(identity);
    if (state === undefined) return;
    state.candidate?.commit();
    this.states.delete(identity);
  }

  /** Publishes CPU data only after the scheduler confirms finalize is still current. */
  commitStage(request: MergedAssetRequestDemand): void {
    if (request.stage !== AssetRequestStage.Finalize) return;
    const state = this.states.get(operationIdentity(request));
    if (state === undefined) return;
    state.operation.publishCpuPayload?.(state.decoded, state.finalized, request);
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

  private async upload(request: MergedAssetRequestDemand): Promise<void | AssetUploadDeferral> {
    const state = this.stateFor(request);
    if (state.finalized === undefined) {
      throw new Error(`Asset pipeline "${request.key}" has no finalized value.`);
    }
    const result = await state.operation.upload(state.finalized, this.device, request);
    if (result !== undefined) {
      if (isUploadCandidate(result)) {
        state.candidate = Object.freeze({
          status: 'staged',
          commit: () => result.commit(),
          discard: () => result.discard()
        });
        return;
      }
      assertAssetUploadDeferral(result);
      return Object.freeze({ status: 'deferred', reason: result.reason });
    }
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

function isUploadCandidate(value: unknown): value is AssetPipelineUploadCandidate {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    value.status === 'staged' &&
    'commit' in value &&
    typeof value.commit === 'function' &&
    'discard' in value &&
    typeof value.discard === 'function'
  );
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
  if (
    operation.publishCpuPayload !== undefined &&
    typeof operation.publishCpuPayload !== 'function'
  ) {
    throw new Error('Asset pipeline CPU publication hook must be a function when provided.');
  }
}
