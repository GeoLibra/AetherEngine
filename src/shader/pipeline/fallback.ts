import { canonicalStringify, stableHash } from '../../core/hash';

export interface ShaderFallbackCompatibility {
  readonly bindingLayout: string;
  readonly vertexLayout: string;
  readonly attachments: readonly string[];
  readonly sampleCount: number;
  readonly value: string;
  readonly hash: string;
}

export function createShaderFallbackKey(
  input: Readonly<{
    bindingLayout: string;
    vertexLayout: string;
    attachments: readonly string[];
    sampleCount: number;
  }>
): ShaderFallbackCompatibility {
  const normalized = {
    bindingLayout: input.bindingLayout,
    vertexLayout: input.vertexLayout,
    attachments: [...input.attachments],
    sampleCount: input.sampleCount
  };
  const value = canonicalStringify(normalized);
  return Object.freeze({
    ...normalized,
    attachments: Object.freeze(normalized.attachments),
    value,
    hash: stableHash(value)
  });
}

export function selectCompatibleShaderFallback<
  T extends Readonly<{ compatibility: ShaderFallbackCompatibility }>
>(wanted: ShaderFallbackCompatibility, candidates: readonly T[]): T | undefined {
  return candidates.find(
    (candidate) =>
      candidate.compatibility.value === wanted.value && candidate.compatibility.hash === wanted.hash
  );
}
