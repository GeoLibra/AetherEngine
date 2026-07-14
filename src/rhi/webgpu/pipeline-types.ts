import type { Diagnostic } from '../../diagnostics';

export type WebGPUPipelineCreationResult<T> =
  | { readonly status: 'success'; readonly pipeline: T }
  | { readonly status: 'failed'; readonly diagnostic: Diagnostic };
