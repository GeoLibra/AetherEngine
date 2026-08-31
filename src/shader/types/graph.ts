export interface ShaderGraphNode {
  readonly id: string;
  readonly kind: string;
  readonly outputType: string;
  readonly inputs?: Readonly<Record<string, string>>;
  readonly value?: unknown;
}

export interface ShaderGraph {
  readonly revision: number;
  readonly nodes: readonly ShaderGraphNode[];
  readonly outputs: Readonly<Record<string, string>>;
}

export interface ShaderGraphWorkerRequest {
  readonly revision: number;
  readonly priority: number;
  readonly graph: ShaderGraph;
  readonly signal: AbortSignal;
}

export interface ShaderGraphWorkerResult<T> {
  readonly revision: number;
  readonly artifact: T;
}

export interface ShaderGraphWorkerPort<T> {
  compile(request: ShaderGraphWorkerRequest): Promise<ShaderGraphWorkerResult<T>>;
}

export type ShaderGraphServiceResult<T> =
  | Readonly<{ status: 'completed'; revision: number; artifact: T }>
  | Readonly<{ status: 'stale' | 'cancelled'; revision: number }>
  | Readonly<{ status: 'failed'; revision: number; error: unknown }>;
