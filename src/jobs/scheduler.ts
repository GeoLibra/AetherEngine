import { sortQueuedJobs, type QueuedJobOrder } from './queue';
import { WorkerPool } from './worker-pool';
import type {
  BudgetClassLimits, EncodedJobInput, JobBudgetClass, JobClock, JobDiagnostic,
  JobHandle, JobRequest, JobResult, JobSchedulerOptions, JobType, WorkerExecutor,
  WorkerOutcome
} from './types';

interface BudgetUsage { jobs: number; inputBytes: number; decodeBytes: number; }
interface JobRecord extends QueuedJobOrder {
  readonly id: number;
  readonly type: JobType<unknown, unknown>;
  readonly encoded: EncodedJobInput;
  readonly transferBytes: number;
  readonly summary: Readonly<Record<string, unknown>>;
  readonly resolve: (result: JobResult<unknown>) => void;
  readonly controller: AbortController;
  state: 'queued' | 'active' | 'terminal';
  attempt: number;
  terminal: boolean;
  startedAt?: number;
}

const UNLIMITED: BudgetClassLimits = Object.freeze({
  maxInFlightJobs: Number.MAX_SAFE_INTEGER,
  maxInputBytes: Number.MAX_SAFE_INTEGER,
  maxDecodeBytes: Number.MAX_SAFE_INTEGER
});

export class JobScheduler {
  private readonly registrations = new Map<string, JobType<unknown, unknown>>();
  private readonly queue: JobRecord[] = [];
  private readonly usage = new Map<JobBudgetClass, BudgetUsage>();
  private readonly clock: JobClock;
  private readonly budgets: Partial<Record<JobBudgetClass, BudgetClassLimits>>;
  private readonly capabilities: { readonly sharedMemory: boolean };
  private readonly pool: WorkerPool;
  private nextId = 0;
  private nextSequence = 0;

  constructor(options: JobSchedulerOptions = {}) {
    this.clock = options.clock ?? { now: () => 0 };
    this.budgets = options.budgets ?? {};
    this.capabilities = { sharedMemory: options.capabilities?.sharedMemory ?? false };
    this.pool = new WorkerPool(
      options.workerFactory,
      options.workerCount ?? (options.workerFactory ? 1 : 0)
    );
  }

  get queuedCount(): number { return this.queue.length; }

  register<I, O>(type: JobType<I, O>): this {
    if (this.registrations.has(type.id)) {
      throw new Error(`Job type "${type.id}" is already registered.`);
    }
    this.registrations.set(type.id, type as JobType<unknown, unknown>);
    return this;
  }

  schedule<I, O>(type: JobType<I, O>, request: JobRequest<I>): JobHandle<O> {
    if (this.registrations.get(type.id) !== type) {
      throw new Error(`Job type "${type.id}" is not registered.`);
    }
    const id = this.nextId++;
    const summary = type.summarize(request.input);
    let encoded: EncodedJobInput;
    try { encoded = type.encode(request.input); }
    catch (error) {
      return failedHandle(id, diagnostic('job-encode-failed', type.id, summary, String(error)));
    }
    if (encoded.usesSharedMemory && (!this.capabilities.sharedMemory || !type.allowSharedMemory)) {
      return failedHandle(
        id,
        diagnostic('job-shared-memory-unsupported', type.id, summary, 'Shared memory is not enabled.')
      );
    }
    const limits = this.budgets[request.budgetClass] ?? UNLIMITED;
    const usage = this.getUsage(request.budgetClass);
    if (usage.jobs + 1 > limits.maxInFlightJobs ||
        usage.inputBytes + encoded.inputBytes > limits.maxInputBytes ||
        usage.decodeBytes + encoded.decodeBytes > limits.maxDecodeBytes) {
      return failedHandle(id, diagnostic('job-budget-exceeded', type.id, summary, 'Job budget exceeded.'));
    }

    let resolve!: (result: JobResult<O>) => void;
    const result = new Promise<JobResult<O>>((complete) => { resolve = complete; });
    const record: JobRecord = {
      id, type: type as JobType<unknown, unknown>, encoded,
      transferBytes: encoded.transfer.reduce((sum, buffer) => sum + buffer.byteLength, 0),
      summary,
      resolve: resolve as (result: JobResult<unknown>) => void,
      controller: new AbortController(), state: 'queued', attempt: 0, terminal: false,
      budgetClass: request.budgetClass, priority: request.priority,
      submittedAt: this.clock.now(), sequence: this.nextSequence++,
      ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
      ...(request.screenSpaceError === undefined ? {} : { screenSpaceError: request.screenSpaceError })
    };
    this.queue.push(record);
    this.addUsage(record.budgetClass, encoded, 1);
    const cancel = (reason = 'cancelled'): void => this.cancel(record, reason);
    if (request.signal) {
      if (request.signal.aborted) cancel(String(request.signal.reason ?? 'cancelled'));
      else request.signal.addEventListener('abort', () => cancel(String(request.signal?.reason ?? 'cancelled')), { once: true });
    }
    this.pump();
    return Object.freeze({ id, result, cancel });
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const worker = this.pool.acquire();
      if (!worker) return;
      const record = sortQueuedJobs(this.queue, this.clock.now())[0]!;
      this.queue.splice(this.queue.indexOf(record), 1);
      record.state = 'active';
      record.startedAt = this.clock.now();
      record.attempt++;
      void this.execute(record, worker);
    }
  }

  private async execute(record: JobRecord, worker: WorkerExecutor): Promise<void> {
    let outcome: WorkerOutcome;
    try {
      outcome = await worker.execute(
        { id: record.id, type: record.type.id, payload: record.encoded.payload, attempt: record.attempt },
        record.encoded.transfer,
        record.controller.signal
      );
    } catch (error) {
      outcome = { status: 'crashed', reason: String(error) };
    }
    if (!record.terminal) {
      if (outcome.status === 'completed') {
        try {
          const output = record.type.decode(outcome.output);
          this.finish(record, Object.freeze({
            status: 'completed', output,
            metrics: Object.freeze({
              queueLatencyMs: (record.startedAt ?? record.submittedAt) - record.submittedAt,
              executionTimeMs: this.clock.now() - (record.startedAt ?? this.clock.now()),
              attempts: record.attempt,
              inputBytes: record.encoded.inputBytes,
              transferBytes: record.transferBytes,
              copyBytes: Math.max(0, record.encoded.inputBytes - record.transferBytes)
            })
          }));
        } catch (error) {
          this.fail(record, 'job-decode-failed', String(error), worker.id);
        }
      } else {
        this.fail(record, outcome.status === 'crashed' ? 'job-worker-crashed' : 'job-worker-failed',
          outcome.status === 'crashed' ? outcome.reason : String(outcome.error), worker.id);
      }
    }
    this.pool.release(worker);
    this.pump();
  }

  private cancel(record: JobRecord, reason: string): void {
    if (record.terminal) return;
    if (record.state === 'queued') this.queue.splice(this.queue.indexOf(record), 1);
    if (record.state === 'active') record.controller.abort(reason);
    this.finish(record, Object.freeze({ status: 'cancelled', reason }));
  }

  private fail(record: JobRecord, code: string, message: string, workerId?: string): void {
    this.finish(record, Object.freeze({
      status: 'failed', diagnostic: diagnostic(code, record.type.id, record.summary, message, record.attempt, workerId)
    }));
  }

  private finish(record: JobRecord, result: JobResult<unknown>): void {
    if (record.terminal) return;
    record.terminal = true;
    record.state = 'terminal';
    this.addUsage(record.budgetClass, record.encoded, -1);
    record.resolve(result);
  }

  private getUsage(budgetClass: JobBudgetClass): BudgetUsage {
    let usage = this.usage.get(budgetClass);
    if (!usage) { usage = { jobs: 0, inputBytes: 0, decodeBytes: 0 }; this.usage.set(budgetClass, usage); }
    return usage;
  }

  private addUsage(budgetClass: JobBudgetClass, encoded: EncodedJobInput, direction: 1 | -1): void {
    const usage = this.getUsage(budgetClass);
    usage.jobs += direction;
    usage.inputBytes += direction * encoded.inputBytes;
    usage.decodeBytes += direction * encoded.decodeBytes;
  }
}

function failedHandle<O>(id: number, value: JobDiagnostic): JobHandle<O> {
  return Object.freeze({ id, result: Promise.resolve(Object.freeze({ status: 'failed', diagnostic: value })), cancel: () => undefined });
}

function diagnostic(
  code: string, jobType: string, inputSummary: Readonly<Record<string, unknown>>,
  message: string, attempt = 0, workerId?: string
): JobDiagnostic {
  return Object.freeze({
    code, severity: 'error', message, subsystem: 'jobs', jobType, inputSummary, attempt,
    ...(workerId === undefined ? {} : { workerId })
  });
}
