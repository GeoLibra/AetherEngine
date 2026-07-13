import { sortQueuedJobs, type QueuedJobOrder } from './queue';
import type {
  BudgetClassLimits,
  EncodedJobInput,
  JobBudgetClass,
  JobDiagnostic,
  JobHandle,
  JobClock,
  JobRequest,
  JobResult,
  JobSchedulerOptions,
  JobType
} from './types';

interface BudgetUsage {
  jobs: number;
  inputBytes: number;
  decodeBytes: number;
}
interface QueuedJob extends QueuedJobOrder {
  readonly id: number;
  readonly type: JobType<unknown, unknown>;
  readonly encoded: EncodedJobInput;
  readonly summary: Readonly<Record<string, unknown>>;
  readonly resolve: (result: JobResult<unknown>) => void;
}

const UNLIMITED: BudgetClassLimits = Object.freeze({
  maxInFlightJobs: Number.MAX_SAFE_INTEGER,
  maxInputBytes: Number.MAX_SAFE_INTEGER,
  maxDecodeBytes: Number.MAX_SAFE_INTEGER
});

export class JobScheduler {
  private readonly registrations = new Map<string, JobType<unknown, unknown>>();
  private readonly queue: QueuedJob[] = [];
  private readonly usage = new Map<JobBudgetClass, BudgetUsage>();
  private readonly clock: JobClock;
  private readonly budgets: Partial<Record<JobBudgetClass, BudgetClassLimits>>;
  private nextId = 0;
  private nextSequence = 0;

  constructor(options: JobSchedulerOptions = {}) {
    this.clock = options.clock ?? { now: () => 0 };
    this.budgets = options.budgets ?? {};
  }

  get queuedCount(): number {
    return this.queue.length;
  }

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
    try {
      encoded = type.encode(request.input);
    } catch (error) {
      return failedHandle(id, diagnostic('job-encode-failed', type.id, summary, String(error)));
    }
    const limits = this.budgets[request.budgetClass] ?? UNLIMITED;
    const usage = this.getUsage(request.budgetClass);
    if (
      usage.jobs + 1 > limits.maxInFlightJobs ||
      usage.inputBytes + encoded.inputBytes > limits.maxInputBytes ||
      usage.decodeBytes + encoded.decodeBytes > limits.maxDecodeBytes
    ) {
      return failedHandle(
        id,
        diagnostic('job-budget-exceeded', type.id, summary, 'Job budget exceeded.')
      );
    }

    let resolve!: (result: JobResult<O>) => void;
    const result = new Promise<JobResult<O>>((complete) => {
      resolve = complete;
    });
    const queued: QueuedJob = {
      id,
      type: type as JobType<unknown, unknown>,
      encoded,
      summary,
      resolve: resolve as (result: JobResult<unknown>) => void,
      budgetClass: request.budgetClass,
      priority: request.priority,
      submittedAt: this.clock.now(),
      ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
      ...(request.screenSpaceError === undefined
        ? {}
        : { screenSpaceError: request.screenSpaceError }),
      sequence: this.nextSequence++
    };
    this.queue.push(queued);
    this.addUsage(request.budgetClass, encoded, 1);
    let terminal = false;
    const cancel = (reason = 'cancelled'): void => {
      if (terminal) return;
      const index = this.queue.indexOf(queued);
      if (index < 0) return;
      terminal = true;
      this.queue.splice(index, 1);
      this.addUsage(request.budgetClass, encoded, -1);
      resolve(Object.freeze({ status: 'cancelled', reason }));
    };
    if (request.signal) {
      if (request.signal.aborted) cancel(String(request.signal.reason ?? 'cancelled'));
      else {
        request.signal.addEventListener(
          'abort',
          () => cancel(String(request.signal?.reason ?? 'cancelled')),
          { once: true }
        );
      }
    }
    return Object.freeze({ id, result, cancel });
  }

  takeNext(): QueuedJob | undefined {
    const next = sortQueuedJobs(this.queue, this.clock.now())[0];
    if (!next) return undefined;
    this.queue.splice(this.queue.indexOf(next), 1);
    return next;
  }

  private getUsage(budgetClass: JobBudgetClass): BudgetUsage {
    let usage = this.usage.get(budgetClass);
    if (!usage) {
      usage = { jobs: 0, inputBytes: 0, decodeBytes: 0 };
      this.usage.set(budgetClass, usage);
    }
    return usage;
  }

  private addUsage(
    budgetClass: JobBudgetClass,
    encoded: EncodedJobInput,
    direction: 1 | -1
  ): void {
    const usage = this.getUsage(budgetClass);
    usage.jobs += direction;
    usage.inputBytes += direction * encoded.inputBytes;
    usage.decodeBytes += direction * encoded.decodeBytes;
  }
}

function failedHandle<O>(id: number, value: JobDiagnostic): JobHandle<O> {
  return Object.freeze({
    id,
    result: Promise.resolve(Object.freeze({ status: 'failed', diagnostic: value })),
    cancel: () => undefined
  });
}

function diagnostic(
  code: string,
  jobType: string,
  inputSummary: Readonly<Record<string, unknown>>,
  message: string
): JobDiagnostic {
  return Object.freeze({
    code,
    severity: 'error',
    message,
    subsystem: 'jobs',
    jobType,
    inputSummary,
    attempt: 0
  });
}
