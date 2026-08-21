import type { RHIBindGroupLayout, RHIComputePipeline, RHIRenderPipeline } from '../rhi/contracts';

/** Typed key for a bind-group layout created before graph surface acquisition. */
export interface PreparedBindGroupLayoutToken {
  readonly kind: 'prepared-bind-group-layout-token';
  readonly name: string;
  readonly id: symbol;
}

export function createPreparedBindGroupLayoutToken(name: string): PreparedBindGroupLayoutToken {
  if (name.length === 0)
    throw new TypeError('Prepared bind-group layout token name must not be empty.');
  return Object.freeze({ kind: 'prepared-bind-group-layout-token', name, id: Symbol(name) });
}

export type PreparedBindGroupLayoutBindings = ReadonlyMap<
  PreparedBindGroupLayoutToken,
  RHIBindGroupLayout
>;

/** Typed key for a compute pipeline created before graph surface acquisition. */
export interface PreparedComputePipelineToken {
  readonly kind: 'prepared-compute-pipeline-token';
  readonly name: string;
  readonly id: symbol;
}

export function createPreparedComputePipelineToken(name: string): PreparedComputePipelineToken {
  if (name.length === 0)
    throw new TypeError('Prepared compute pipeline token name must not be empty.');
  return Object.freeze({ kind: 'prepared-compute-pipeline-token', name, id: Symbol(name) });
}

export type PreparedComputePipelineBindings = ReadonlyMap<
  PreparedComputePipelineToken,
  RHIComputePipeline
>;

/** Typed key for a render pipeline created before graph surface acquisition. */
export interface PreparedRenderPipelineToken {
  readonly kind: 'prepared-render-pipeline-token';
  readonly name: string;
  readonly id: symbol;
}

export function createPreparedRenderPipelineToken(name: string): PreparedRenderPipelineToken {
  if (name.length === 0)
    throw new TypeError('Prepared render pipeline token name must not be empty.');
  return Object.freeze({ kind: 'prepared-render-pipeline-token', name, id: Symbol(name) });
}

export type PreparedRenderPipelineBindings = ReadonlyMap<
  PreparedRenderPipelineToken,
  RHIRenderPipeline
>;
