import type { PipelineKeyParts } from './pipeline-resolver';
import type { ShaderDiagnostic } from '../shader/types';

export interface MaterialResolutionRecordFacts {
  readonly selectedTechnique: string;
  readonly selectedVariant: string;
  readonly pipelineKeyParts: PipelineKeyParts;
  readonly cacheOutcome: 'hit' | 'miss';
  readonly fallbackReason?: string;
  readonly missingBindings: readonly string[];
  readonly parameterUploadBytes: number;
  readonly lastCompileDiagnostic?: ShaderDiagnostic;
}

export interface MaterialResolutionRecord {
  readonly selectedTechnique: string;
  readonly selectedVariant: string;
  readonly pipelineKeyParts: Readonly<PipelineKeyParts>;
  readonly cacheOutcome: 'hit' | 'miss';
  readonly fallbackReason?: string;
  readonly missingBindings: readonly string[];
  readonly parameterUploadBytes: number;
  readonly lastCompileDiagnostic?: ShaderDiagnostic;
}

export function createMaterialResolutionRecord(
  facts: MaterialResolutionRecordFacts
): MaterialResolutionRecord {
  return deepFreeze(deepClone(facts)) as MaterialResolutionRecord;
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => deepClone(entry)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, deepClone(entry)])
    ) as T;
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}
