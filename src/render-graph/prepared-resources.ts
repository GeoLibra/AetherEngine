import type { RHIRenderPipeline } from '../rhi/contracts';

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
