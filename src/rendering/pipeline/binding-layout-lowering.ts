import type { GPUBindGroupLayoutEntry } from '../../rhi';
import type {
  BindingLayoutLoweringOptions,
  BindingLayoutLoweringResult,
  BindingLayoutLoweringTarget,
  BindingLayoutPlan,
  BindingLayoutUnsupported,
  CanonicalBindingLayoutEntry,
  WebGl2BindingLayoutPlan,
  WebGpuBindingLayoutPlan
} from './types';

const WEBGPU_STAGE = Object.freeze({ vertex: 1, fragment: 2, compute: 4 } as const);

/** Lowers a validated portable binding ABI without creating native objects. */
export function lowerBindingLayoutPlan(
  plan: BindingLayoutPlan,
  target: BindingLayoutLoweringTarget,
  options: BindingLayoutLoweringOptions = {}
): BindingLayoutLoweringResult {
  const limitFailure = validateLimits(plan, target, options);
  if (limitFailure !== undefined) return limitFailure;
  return target === 'webgpu' ? lowerWebGpu(plan) : lowerWebGl2(plan, options);
}

function lowerWebGpu(plan: BindingLayoutPlan): WebGpuBindingLayoutPlan {
  const groups = plan.groups.map((group) => {
    const visibility = group.visibility.reduce((flags, stage) => flags | WEBGPU_STAGE[stage], 0);
    return Object.freeze({
      group: group.group,
      descriptor: Object.freeze({
        entries: Object.freeze(group.bindings.map((entry) => webGpuEntry(entry, visibility)))
      })
    });
  });
  return Object.freeze({
    kind: 'webgpu',
    layout: plan.id,
    groups: Object.freeze(groups),
    dynamicOffsetOrder: plan.dynamicOffsetOrder
  });
}

function webGpuEntry(
  entry: CanonicalBindingLayoutEntry,
  visibility: number
): GPUBindGroupLayoutEntry {
  const base = { binding: entry.binding, visibility };
  if (entry.kind === 'uniform-buffer' || entry.kind === 'storage-buffer')
    return Object.freeze({
      ...base,
      buffer: Object.freeze({
        type:
          entry.kind === 'uniform-buffer'
            ? 'uniform'
            : entry.access === 'read'
              ? 'read-only-storage'
              : 'storage',
        hasDynamicOffset: entry.dynamicOffset,
        minBindingSize: entry.minimumByteSize
      })
    });
  if (entry.kind === 'texture')
    return Object.freeze({
      ...base,
      texture: Object.freeze({
        sampleType: entry.sampleType,
        viewDimension: entry.viewDimension,
        multisampled: entry.multisampled
      })
    });
  return Object.freeze({ ...base, sampler: Object.freeze({ type: entry.samplerType }) });
}

function lowerWebGl2(
  plan: BindingLayoutPlan,
  options: BindingLayoutLoweringOptions
): BindingLayoutLoweringResult {
  const storage = plan.groups
    .flatMap((group) => group.bindings)
    .find((entry) => entry.kind === 'storage-buffer');
  if (storage !== undefined && options.allowWebGl2StorageBuffers !== true)
    return unsupported(
      'webgl2',
      'storage-buffer-unsupported',
      'WebGL2 storage-buffer lowering requires an approved semantic replacement.',
      storage
    );
  const entries = plan.groups.flatMap((group) => group.bindings);
  let textureUnit = 0;
  const textures = entries
    .filter((entry) => entry.kind === 'texture')
    .map((entry) =>
      Object.freeze({
        group: entry.group,
        binding: entry.binding,
        textureUnit: textureUnit++,
        viewDimension: entry.viewDimension,
        sampleType: entry.sampleType,
        multisampled: entry.multisampled
      })
    );
  let samplerUnit = 0;
  const samplers = entries
    .filter((entry) => entry.kind === 'sampler')
    .map((entry) =>
      Object.freeze({
        group: entry.group,
        binding: entry.binding,
        textureUnit: samplerUnit++,
        samplerType: entry.samplerType
      })
    );
  const result: WebGl2BindingLayoutPlan = Object.freeze({
    kind: 'webgl2',
    layout: plan.id,
    uniformBlocks: Object.freeze(
      entries
        .filter((entry) => entry.kind === 'uniform-buffer')
        .map((entry) =>
          Object.freeze({
            group: entry.group,
            binding: entry.binding,
            byteSize: entry.minimumByteSize
          })
        )
    ),
    storageBuffers: Object.freeze(
      entries
        .filter((entry) => entry.kind === 'storage-buffer')
        .map((entry) =>
          Object.freeze({
            group: entry.group,
            binding: entry.binding,
            byteSize: entry.minimumByteSize,
            access: entry.access
          })
        )
    ),
    textures: Object.freeze(textures),
    samplers: Object.freeze(samplers),
    dynamicOffsetOrder: plan.dynamicOffsetOrder
  });
  return result;
}

function validateLimits(
  plan: BindingLayoutPlan,
  target: BindingLayoutLoweringTarget,
  options: BindingLayoutLoweringOptions
): BindingLayoutUnsupported | undefined {
  const highestGroupCount = (plan.groups.at(-1)?.group ?? -1) + 1;
  if (options.maxBindGroups !== undefined && highestGroupCount > options.maxBindGroups)
    return unsupported(
      target,
      'bind-group-limit-exceeded',
      `Binding layout requires ${highestGroupCount} group slots; target permits ${options.maxBindGroups}.`
    );
  const oversized = plan.groups.find(
    (group) =>
      options.maxBindingsPerGroup !== undefined &&
      group.bindings.length > options.maxBindingsPerGroup
  );
  if (oversized !== undefined)
    return unsupported(
      target,
      'bindings-per-group-limit-exceeded',
      `Binding group ${oversized.group} exceeds the target binding limit.`,
      { group: oversized.group }
    );
  const textureCount = plan.groups
    .flatMap((group) => group.bindings)
    .filter((entry) => entry.kind === 'texture').length;
  if (options.maxTextureUnits !== undefined && textureCount > options.maxTextureUnits)
    return unsupported(
      target,
      'texture-unit-limit-exceeded',
      `Binding layout requires ${textureCount} texture units; target permits ${options.maxTextureUnits}.`
    );
  return undefined;
}

function unsupported(
  target: BindingLayoutLoweringTarget,
  code: BindingLayoutUnsupported['diagnostic']['code'],
  message: string,
  location: { readonly group?: number; readonly binding?: number } = {}
): BindingLayoutUnsupported {
  return Object.freeze({
    kind: 'unsupported',
    target,
    diagnostic: Object.freeze({ code, message, ...location })
  });
}
