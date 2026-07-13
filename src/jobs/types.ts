import type { Diagnostic } from '../diagnostics';

export type JobBudgetClass = 'interactive' | 'streaming' | 'background';

export interface EncodedJobInput {
  readonly payload: unknown;
  readonly inputBytes: number;
  readonly decodeBytes: number;
  readonly transfer: readonly ArrayBuffer[];
  readonly usesSharedMemory?: boolean;
}

export interface JobType<I, O> {
  readonly id: string;
  readonly encode: (input: I) => EncodedJobInput;
  readonly decode: (value: unknown) => O;
  readonly summarize: (input: I) => Readonly<Record<string, unknown>>;
  readonly idempotent: boolean;
  readonly retryLimit: number;
  readonly allowSharedMemory: boolean;
  readonly __input?: I;
  readonly __output?: O;
}

export interface JobTypeDefinition<I, O> {
  readonly id: string;
  readonly encode: (input: I) => EncodedJobInput;
  readonly decode: (value: unknown) => O;
  readonly summarize: (input: I) => Readonly<Record<string, unknown>>;
  readonly idempotent?: boolean;
  readonly retryLimit?: number;
  readonly allowSharedMemory?: boolean;
}

export interface JobRequest<I> {
  readonly input: I;
  readonly priority: number;
  readonly budgetClass: JobBudgetClass;
  readonly deadlineMs?: number;
  readonly screenSpaceError?: number;
  readonly signal?: AbortSignal;
}

export interface JobExecutionMetrics {
  readonly queueLatencyMs: number;
  readonly executionTimeMs: number;
  readonly attempts: number;
  readonly inputBytes: number;
  readonly transferBytes: number;
  readonly copyBytes: number;
}

export interface JobDiagnostic extends Diagnostic {
  readonly jobType: string;
  readonly inputSummary: Readonly<Record<string, unknown>>;
  readonly attempt: number;
  readonly workerId?: string;
}

export type JobResult<O> =
  | { readonly status: 'completed'; readonly output: O; readonly metrics: JobExecutionMetrics }
  | { readonly status: 'cancelled'; readonly reason: string }
  | { readonly status: 'failed'; readonly diagnostic: JobDiagnostic };

export interface JobHandle<O> {
  readonly id: number;
  readonly result: Promise<JobResult<O>>;
  cancel(reason?: string): void;
}

export interface JobClock { now(): number; }

export interface BudgetClassLimits {
  readonly maxInFlightJobs: number;
  readonly maxInputBytes: number;
  readonly maxDecodeBytes: number;
}

export interface JobSchedulerOptions {
  readonly clock?: JobClock;
  readonly budgets?: Partial<Record<JobBudgetClass, BudgetClassLimits>>;
  readonly workerFactory?: WorkerFactory;
  readonly workerCount?: number;
  readonly capabilities?: { readonly sharedMemory?: boolean };
}

export interface JobEnvelope {
  readonly id: number;
  readonly type: string;
  readonly payload: unknown;
  readonly attempt: number;
}

export type WorkerOutcome =
  | { readonly status: 'completed'; readonly output: unknown }
  | { readonly status: 'failed'; readonly error: unknown }
  | { readonly status: 'crashed'; readonly reason: string };

export interface WorkerExecutor {
  readonly id: string;
  execute(
    envelope: JobEnvelope,
    transfer: readonly ArrayBuffer[],
    signal: AbortSignal
  ): Promise<WorkerOutcome>;
  dispose(): void | Promise<void>;
}

export interface WorkerFactory { create(workerId: number): WorkerExecutor; }
