import type { RHIComputePipeline, RHIRenderPipeline } from '../../rhi/contracts';
import type { PreparedDrawPacket } from '../../rendering/phase';

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

/** Typed key for prepared draw packet resources created before graph surface acquisition. */
export interface PreparedDrawResourcesToken {
  readonly kind: 'prepared-draw-resources-token';
  readonly name: string;
  readonly id: symbol;
}

export function createPreparedDrawResourcesToken(name: string): PreparedDrawResourcesToken {
  if (name.length === 0)
    throw new TypeError('Prepared draw resources token name must not be empty.');
  return Object.freeze({ kind: 'prepared-draw-resources-token', name, id: Symbol(name) });
}

export type PreparedDrawResourcesBindings = ReadonlyMap<
  PreparedDrawResourcesToken,
  PreparedDrawPacket
>;

export type PreparedDrawResourceBindings = PreparedDrawResourcesBindings;
