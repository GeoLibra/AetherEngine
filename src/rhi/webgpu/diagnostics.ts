import type { Diagnostic } from '../../diagnostics';
import type { WebGPUNativeErrorPort } from './native-types';

export function normalizeWebGPUNativeError(cause: unknown): WebGPUNativeErrorPort {
  if (isNativeError(cause)) return cause;
  return Object.freeze({
    type: 'unknown',
    message: cause instanceof Error ? cause.message : String(cause)
  });
}

export function createWebGPUUncapturedDiagnostic(
  generation: number,
  error: WebGPUNativeErrorPort
): Diagnostic {
  return Object.freeze({
    code: `rhi/webgpu-uncaptured-${error.type}`,
    severity: 'error',
    message: error.message,
    subsystem: 'rhi.webgpu',
    ...(error.source === undefined ? {} : { source: Object.freeze({ ...error.source }) }),
    context: Object.freeze({ deviceGeneration: generation, errorType: error.type })
  });
}

export function createWebGPUPipelineDiagnostic(
  generation: number,
  operation: string,
  label: string | undefined,
  error: WebGPUNativeErrorPort
): Diagnostic {
  return Object.freeze({
    code: `rhi/webgpu-pipeline-${error.type}`,
    severity: 'error',
    message: error.message,
    subsystem: 'rhi.webgpu',
    ...(error.source === undefined ? {} : { source: Object.freeze({ ...error.source }) }),
    context: Object.freeze({
      deviceGeneration: generation,
      errorType: error.type,
      operation,
      resourceLabel: label ?? 'unlabeled'
    })
  });
}

function isNativeError(value: unknown): value is WebGPUNativeErrorPort {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<WebGPUNativeErrorPort>;
  return typeof candidate.message === 'string' &&
    (candidate.type === 'validation' || candidate.type === 'out-of-memory' ||
      candidate.type === 'internal' || candidate.type === 'unknown');
}
