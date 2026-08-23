import type {
  PipelineCacheEntryState,
  PipelineCacheMetrics,
  PipelineCompileOutcome,
  PipelineCompileRequest,
  PipelineCompiler,
  PipelineInterestLease,
  PipelineInvalidationReason
} from './types';

const ABSENT_PIPELINE_STATE: PipelineCacheEntryState = Object.freeze({ kind: 'absent' });

interface PipelineCacheRecord {
  readonly request: PipelineCompileRequest;
  readonly requestId: string;
  state: PipelineCacheEntryState;
  interests: number;
}

/**
 * Validates and snapshots caller-owned pipeline request identity facts.
 *
 * @returns An immutable request whose revisions and device generation are non-negative integers.
 * @throws When a key/hash is empty or a revision/generation is invalid.
 */
export function createPipelineCompileRequest(
  input: PipelineCompileRequest
): PipelineCompileRequest {
  validateText(input.pipelineKey, 'pipeline key');
  validateText(input.featurePolicyHash, 'FeaturePolicy hash');
  validateInteger(input.requestRevision, 'request revision');
  validateInteger(input.shaderRevision, 'shader revision');
  validateInteger(input.layoutRevision, 'layout revision');
  validateInteger(input.deviceGeneration, 'device generation');
  return Object.freeze({ ...input });
}

/** CPU-side pipeline availability cache queried synchronously by Queue. */
export class PipelineCache {
  private readonly records = new Map<string, PipelineCacheRecord>();
  private nextRequestId = 1;
  private duplicateRequests = 0;
  private compileStarts = 0;
  private compileErrors = 0;
  private staleResultsDiscarded = 0;
  private readyPublications = 0;

  /**
   * Creates a cache around an asynchronous compiler port.
   *
   * @throws When the compiler or monotonic-clock port is malformed.
   */
  constructor(
    private readonly compiler: PipelineCompiler,
    private readonly now: () => number = Date.now
  ) {
    if (typeof compiler?.compile !== 'function')
      throw new Error('Pipeline compiler must provide a compile function.');
    if (typeof now !== 'function') throw new Error('Pipeline cache clock must be a function.');
  }

  /**
   * Returns the current immutable state without compiling or waiting.
   *
   * @throws When the canonical pipeline key is empty.
   */
  snapshot(pipelineKey: string): PipelineCacheEntryState {
    if (typeof pipelineKey !== 'string' || !pipelineKey.trim())
      throw new Error('Pipeline cache key must be non-empty.');
    return this.records.get(pipelineKey)?.state ?? ABSENT_PIPELINE_STATE;
  }

  /**
   * Coalesces an asynchronous compile request and returns an idempotent interest lease.
   * The compiler is invoked in a later microtask, never in this Queue-facing call.
   *
   * @throws When request facts are malformed or conflict with the active key identity.
   */
  request(input: PipelineCompileRequest): PipelineInterestLease {
    const request = createPipelineCompileRequest(input);
    let record = this.records.get(request.pipelineKey);
    if (record === undefined || record.state.kind === 'stale') record = this.queue(request);
    else if (!sameRequestIdentity(record.request, request))
      throw new Error('Pipeline cache key was requested with different identity facts.');
    else if (record.state.kind === 'queued' || record.state.kind === 'compiling')
      this.duplicateRequests += 1;
    record.interests += 1;
    return this.createInterestLease(record);
  }

  /** Marks an existing entry stale so a later request can establish a new identity. */
  invalidate(pipelineKey: string, reason: PipelineInvalidationReason): void {
    if (typeof pipelineKey !== 'string' || !pipelineKey.trim())
      throw new Error('Pipeline cache invalidation key must be non-empty.');
    if (!isInvalidationReason(reason))
      throw new Error('Pipeline cache invalidation reason is invalid.');
    const record = this.records.get(pipelineKey);
    if (record !== undefined) record.state = Object.freeze({ kind: 'stale', reason });
  }

  /** Returns an immutable copy of cache lifecycle counters. */
  metrics(): PipelineCacheMetrics {
    return Object.freeze({
      duplicateRequests: this.duplicateRequests,
      compileStarts: this.compileStarts,
      compileErrors: this.compileErrors,
      staleResultsDiscarded: this.staleResultsDiscarded,
      readyPublications: this.readyPublications
    });
  }

  private queue(request: PipelineCompileRequest): PipelineCacheRecord {
    const requestId = `pipeline-request:${this.nextRequestId}`;
    this.nextRequestId += 1;
    const record: PipelineCacheRecord = {
      request,
      requestId,
      state: Object.freeze({ kind: 'queued', requestId }),
      interests: 0
    };
    this.records.set(request.pipelineKey, record);
    queueMicrotask(() => this.startCompile(record));
    return record;
  }

  private createInterestLease(record: PipelineCacheRecord): PipelineInterestLease {
    let released = false;
    return Object.freeze({
      pipelineKey: record.request.pipelineKey,
      requestId: record.requestId,
      get released() {
        return released;
      },
      release: () => {
        if (released) return;
        released = true;
        record.interests -= 1;
        if (record.interests === 0 && record.state.kind === 'queued')
          this.records.delete(record.request.pipelineKey);
      }
    });
  }

  private startCompile(record: PipelineCacheRecord): void {
    if (
      this.records.get(record.request.pipelineKey) !== record ||
      record.state.kind !== 'queued' ||
      record.interests === 0
    )
      return;
    record.state = Object.freeze({
      kind: 'compiling',
      requestId: record.requestId,
      startedAt: this.now()
    });
    this.compileStarts += 1;
    void this.compile(record);
  }

  private async compile(record: PipelineCacheRecord): Promise<void> {
    const outcome = await compileSafely(this.compiler, record.request);
    if (
      this.records.get(record.request.pipelineKey) !== record ||
      record.state.kind !== 'compiling'
    ) {
      this.staleResultsDiscarded += 1;
      disposeUnpublished(outcome);
      return;
    }
    if (outcome.status === 'success') {
      record.state = Object.freeze({
        kind: 'ready',
        pipeline: outcome.pipeline,
        deviceGeneration: record.request.deviceGeneration
      });
      this.readyPublications += 1;
      return;
    }
    record.state = Object.freeze({
      kind: 'errored',
      diagnostic: Object.freeze({ ...outcome.diagnostic }),
      retry: 'input-change'
    });
    this.compileErrors += 1;
  }
}

function disposeUnpublished(outcome: PipelineCompileOutcome): void {
  if (outcome.status !== 'success' || outcome.disposeUnpublished === undefined) return;
  try {
    outcome.disposeUnpublished();
  } catch {
    // Cleanup failure cannot make an invalidated pipeline publishable again.
  }
}

function isInvalidationReason(value: string): value is PipelineInvalidationReason {
  return (
    value === 'request-revision-changed' ||
    value === 'shader-revision-changed' ||
    value === 'layout-revision-changed' ||
    value === 'feature-policy-changed' ||
    value === 'device-generation-changed'
  );
}

async function compileSafely(
  compiler: PipelineCompiler,
  request: PipelineCompileRequest
): Promise<PipelineCompileOutcome> {
  try {
    return await compiler.compile(request);
  } catch (error) {
    return {
      status: 'error',
      diagnostic: {
        code: 'pipeline-compile-failed',
        message: boundedErrorMessage(error)
      }
    };
  }
}

function sameRequestIdentity(left: PipelineCompileRequest, right: PipelineCompileRequest): boolean {
  return (
    left.pipelineKey === right.pipelineKey &&
    left.requestRevision === right.requestRevision &&
    left.shaderRevision === right.shaderRevision &&
    left.layoutRevision === right.layoutRevision &&
    left.featurePolicyHash === right.featurePolicyHash &&
    left.deviceGeneration === right.deviceGeneration
  );
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1024) || 'Pipeline compilation failed.';
}

function validateText(value: string, name: string): void {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Pipeline compile ${name} must be non-empty.`);
}

function validateInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`Pipeline compile ${name} must be a non-negative safe integer.`);
}
