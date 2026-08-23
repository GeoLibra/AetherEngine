import type { ShaderBindingManifest } from '../../src/shader';
import { LayoutCache, compileBindingLayoutPlan, lowerBindingLayoutPlan } from '../../src/rendering';

export interface BindingLayoutScenarioInput {
  readonly groups: number;
  readonly bindingsPerGroup: number;
  readonly cacheHits: number;
}

export interface BindingLayoutScenarioResult {
  readonly bindingCount: number;
  readonly reorderEquivalent: boolean;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly unsupportedCount: number;
  readonly synchronousRhiCreates: number;
  readonly checksum: number;
}

/** Deterministic correctness/counter oracle for binding ABI compilation and cache lookup. */
export function runBindingLayoutScenario(
  input: BindingLayoutScenarioInput
): BindingLayoutScenarioResult {
  validateInput(input);
  const manifest = createManifest(input.groups, input.bindingsPerGroup);
  const reordered = reorderManifest(manifest);
  const first = compileBindingLayoutPlan(manifest);
  const second = compileBindingLayoutPlan(reordered);
  if (first.kind !== 'success' || second.kind !== 'success')
    throw new Error('Binding layout benchmark fixture must compile.');
  const cache = new LayoutCache();
  const request = {
    plan: first.plan,
    layoutRevision: 1,
    featurePolicyHash: 'benchmark-policy',
    target: 'webgpu' as const,
    deviceGeneration: 1
  };
  cache.resolve(request);
  for (let index = 0; index < input.cacheHits; index += 1) cache.resolve(request);
  const unsupported = lowerBindingLayoutPlan(first.plan, 'webgpu', {
    maxBindGroups: input.groups - 1
  });
  const metrics = cache.metrics();
  return Object.freeze({
    bindingCount: input.groups * input.bindingsPerGroup,
    reorderEquivalent: first.plan.id === second.plan.id,
    cacheHits: metrics.hits,
    cacheMisses: metrics.misses,
    unsupportedCount: unsupported.kind === 'unsupported' ? 1 : 0,
    synchronousRhiCreates: 0,
    checksum: checksum(first.plan.hash, first.plan.groups.length, metrics.hits)
  });
}

function createManifest(groups: number, bindingsPerGroup: number): ShaderBindingManifest {
  const buffers = Array.from({ length: groups * bindingsPerGroup }, (_, index) => ({
    name: `buffer-${index}`,
    shaderAbiVersion: 1,
    target: 'wgsl' as const,
    addressSpace: 'uniform' as const,
    access: 'read' as const,
    policy: 'wgsl-uniform' as const,
    byteSize: 64,
    alignment: 16,
    fields: Object.freeze([]),
    layoutHash: `buffer-layout-${index}`
  }));
  return {
    shaderAbiVersion: 1,
    groups: Array.from({ length: groups }, (_, group) => ({
      group,
      visibility: Object.freeze(['vertex', 'fragment'] as const),
      entries: Array.from({ length: bindingsPerGroup }, (_, binding) => {
        const index = group * bindingsPerGroup + binding;
        return Object.freeze({
          kind: 'uniform-buffer' as const,
          group,
          binding,
          name: `binding-${index}`,
          bufferLayoutName: `buffer-${index}`
        });
      })
    })),
    buffers,
    vertexInputs: [],
    fragmentOutputs: [],
    layoutHash: 'benchmark-authoring-layout'
  };
}

function reorderManifest(manifest: ShaderBindingManifest): ShaderBindingManifest {
  return {
    ...manifest,
    groups: [...manifest.groups]
      .reverse()
      .map((group) => ({ ...group, entries: [...group.entries].reverse() })),
    buffers: [...manifest.buffers].reverse()
  };
}

function checksum(hash: string, groups: number, hits: number): number {
  let value = groups * 31 + hits;
  for (let index = 0; index < hash.length; index += 1)
    value = (Math.imul(value, 33) ^ hash.charCodeAt(index)) >>> 0;
  return value;
}

function validateInput(input: BindingLayoutScenarioInput): void {
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isInteger(value) || value < (name === 'cacheHits' ? 0 : 1))
      throw new Error(`Binding layout scenario ${name} is invalid.`);
  }
}
