import type { PipelineCacheEntryState, PipelineCompileRequest, PipelineCompiler } from './types';

const ABSENT_PIPELINE_STATE: PipelineCacheEntryState = Object.freeze({ kind: 'absent' });

/**
 * Validates and snapshots caller-owned pipeline request identity facts.
 *
 * @throws When a key/hash is empty or a revision/generation is not a non-negative safe integer.
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
  return Object.freeze({
    pipelineKey: input.pipelineKey,
    requestRevision: input.requestRevision,
    shaderRevision: input.shaderRevision,
    layoutRevision: input.layoutRevision,
    featurePolicyHash: input.featurePolicyHash,
    deviceGeneration: input.deviceGeneration
  });
}

/** CPU-side pipeline availability cache queried synchronously by Queue. */
export class PipelineCache {
  /**
   * Creates a cache around an asynchronous compiler port.
   *
   * @throws When the compiler port does not provide a compile function.
   */
  constructor(compiler: PipelineCompiler) {
    if (typeof compiler?.compile !== 'function')
      throw new Error('Pipeline compiler must provide a compile function.');
  }

  /**
   * Returns the current immutable state without compiling or waiting.
   *
   * @throws When the canonical pipeline key is empty.
   */
  snapshot(pipelineKey: string): PipelineCacheEntryState {
    if (typeof pipelineKey !== 'string' || !pipelineKey.trim())
      throw new Error('Pipeline cache key must be non-empty.');
    return ABSENT_PIPELINE_STATE;
  }
}

function validateText(value: string, name: string): void {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Pipeline compile ${name} must be non-empty.`);
}

function validateInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`Pipeline compile ${name} must be a non-negative safe integer.`);
}
