import { stableHash } from '../utils/hash';
import { selectShaderLayoutPolicy } from './policy';
import { createBoundBufferLayoutManifest } from './struct-layout';
import type {
  BindingGroupManifest,
  BufferLayoutManifest,
  ShaderBindingEntryManifest,
  ShaderBindingManifest,
  ShaderBindingManifestOptions,
  ShaderBindingReflectionDiagnostic,
  ShaderModuleIR,
  ShaderSamplerBindingRequirement,
  ShaderStage,
  ShaderTarget
} from '../types';

export class ShaderBindingReflectionError extends Error {
  readonly diagnostic: Readonly<ShaderBindingReflectionDiagnostic>;

  constructor(diagnostic: ShaderBindingReflectionDiagnostic) {
    super(diagnostic.message);
    this.name = 'ShaderBindingReflectionError';
    this.diagnostic = Object.freeze({ ...diagnostic });
  }
}

export function indexBindingRequirements(
  requirements: readonly ShaderSamplerBindingRequirement[]
): Map<string, ShaderSamplerBindingRequirement> {
  const indexed = new Map<string, ShaderSamplerBindingRequirement>();
  for (const requirement of requirements) {
    const key = bindingKey(requirement.group, requirement.binding);
    if (indexed.has(key)) {
      throw reflectionError(
        'duplicate-binding-requirement',
        requirement.group,
        requirement.binding,
        'Shader binding requirements must be unique by group and binding.'
      );
    }
    indexed.set(key, requirement);
  }
  return indexed;
}

export function reflectBindingEntry(
  group: number,
  binding: number,
  name: string,
  sourceType: string,
  addressSpace: ShaderModuleIR['globals'][number]['addressSpace'],
  requirement: ShaderSamplerBindingRequirement | undefined
): ShaderBindingEntryManifest {
  if (addressSpace === 'uniform' || addressSpace === 'storage') {
    if (requirement !== undefined) {
      throw reflectionError(
        'binding-requirement-kind-mismatch',
        group,
        binding,
        'Sampler requirement targets a buffer binding.',
        name,
        sourceType
      );
    }
    return Object.freeze({
      kind: addressSpace === 'uniform' ? 'uniform-buffer' : 'storage-buffer',
      group,
      binding,
      name,
      bufferLayoutName: name
    });
  }

  const texture = reflectTextureBinding(group, binding, name, sourceType);
  if (texture !== undefined) {
    if (requirement !== undefined) {
      throw reflectionError(
        'binding-requirement-kind-mismatch',
        group,
        binding,
        'Sampler requirement targets a texture binding.',
        name,
        sourceType
      );
    }
    return texture;
  }

  if (sourceType === 'sampler' || sourceType === 'sampler_comparison') {
    const sourceSamplerType = sourceType === 'sampler' ? 'filtering' : 'comparison';
    // Only a typed requirement may narrow a plain sampler to non-filtering;
    // comparison semantics remain explicit in the source type.
    if (
      requirement !== undefined &&
      ((sourceSamplerType === 'comparison' && requirement.samplerType !== 'comparison') ||
        (sourceSamplerType === 'filtering' && requirement.samplerType === 'comparison'))
    ) {
      throw reflectionError(
        'binding-requirement-conflict',
        group,
        binding,
        'Sampler requirement conflicts with the source sampler type.',
        name,
        sourceType
      );
    }
    return Object.freeze({
      kind: 'sampler',
      group,
      binding,
      name,
      samplerType: requirement?.samplerType ?? sourceSamplerType
    });
  }

  throw reflectionError(
    'unsupported-binding-type',
    group,
    binding,
    `Unsupported shader binding type "${sourceType}".`,
    name,
    sourceType
  );
}

function reflectTextureBinding(
  group: number,
  binding: number,
  name: string,
  sourceType: string
): ShaderBindingEntryManifest | undefined {
  const textureTypes = {
    'texture_2d<f32>': { viewDimension: '2d', sampleType: 'float', multisampled: false },
    'texture_cube<f32>': { viewDimension: 'cube', sampleType: 'float', multisampled: false },
    'texture_multisampled_2d<f32>': {
      viewDimension: '2d',
      sampleType: 'float',
      multisampled: true
    },
    texture_depth_2d: { viewDimension: '2d', sampleType: 'depth', multisampled: false }
  } as const;
  const facts = textureTypes[sourceType as keyof typeof textureTypes];
  if (facts !== undefined) {
    return Object.freeze({ kind: 'texture', group, binding, name, ...facts });
  }
  if (sourceType.startsWith('texture')) {
    throw reflectionError(
      'unsupported-binding-type',
      group,
      binding,
      `Unsupported shader texture binding type "${sourceType}".`,
      name,
      sourceType
    );
  }
  return undefined;
}

export function bindingKey(group: number, binding: number): string {
  return `${group}:${binding}`;
}

export function reflectionError(
  code: ShaderBindingReflectionDiagnostic['code'],
  group: number,
  binding: number,
  message: string,
  name?: string,
  sourceType?: string
): ShaderBindingReflectionError {
  return new ShaderBindingReflectionError({
    code,
    group,
    binding,
    ...(name === undefined ? {} : { name }),
    ...(sourceType === undefined ? {} : { sourceType }),
    message
  });
}

/**
 * Creates the complete ShaderBindingManifest describing bind groups, buffer layouts,
 * vertex inputs, and fragment outputs of a shader module.
 */
export function createShaderBindingManifest(
  ir: ShaderModuleIR,
  shaderAbiVersion: number,
  target: ShaderTarget = 'wgsl',
  options: ShaderBindingManifestOptions = {}
): ShaderBindingManifest {
  const visibility = bindingVisibility(ir);
  const structs = new Map(ir.types.map((type) => [type.name, type]));
  const requirements = indexBindingRequirements(options.bindingRequirements ?? []);
  const grouped = new Map<number, ShaderBindingEntryManifest[]>();
  const reflectedBindings = new Set<string>();
  const buffers: BufferLayoutManifest[] = [];
  for (const global of ir.globals) {
    if (global.group === undefined || global.binding === undefined) continue;
    const key = bindingKey(global.group, global.binding);
    if (reflectedBindings.has(key)) {
      throw reflectionError(
        'duplicate-reflected-binding',
        global.group,
        global.binding,
        'Shader reflection contains duplicate group and binding coordinates.',
        global.name,
        global.type
      );
    }
    reflectedBindings.add(key);
    const requirement = requirements.get(key);
    const entry = reflectBindingEntry(
      global.group,
      global.binding,
      global.name,
      global.type,
      global.addressSpace,
      requirement
    );
    const entries = grouped.get(global.group) ?? [];
    entries.push(entry);
    grouped.set(global.group, entries);
    requirements.delete(key);
    if (global.addressSpace === 'uniform' || global.addressSpace === 'storage') {
      const policy = selectShaderLayoutPolicy(target, global.addressSpace);
      buffers.push(
        createBoundBufferLayoutManifest(
          global,
          structs.get(global.type),
          ir.types,
          shaderAbiVersion,
          {
            policy: policy.id,
            target,
            addressSpace: global.addressSpace,
            access: global.access
          }
        )
      );
    }
  }
  const missingRequirement = requirements.values().next().value as
    ShaderSamplerBindingRequirement | undefined;
  if (missingRequirement !== undefined) {
    throw reflectionError(
      'missing-binding-requirement-target',
      missingRequirement.group,
      missingRequirement.binding,
      'Binding requirement does not target a reflected shader binding.'
    );
  }
  buffers.sort(
    (left, right) =>
      compareCodeUnits(left.name, right.name) || compareCodeUnits(left.layoutHash, right.layoutHash)
  );
  const groups: BindingGroupManifest[] = [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([group, entries]) =>
      Object.freeze({
        group,
        visibility,
        entries: Object.freeze(entries.sort((left, right) => left.binding - right.binding))
      })
    );
  const vertexInputs = canonicalStageIo([
    ...ir.globals
      .filter((value) => value.addressSpace === 'in' && value.location !== undefined)
      .map((value) => ({ location: value.location!, name: value.name, type: value.type })),
    ...ir.entryPoints
      .filter((entry) => entry.stage === 'vertex')
      .flatMap((entry) =>
        entry.parameters
          .filter((parameter) => parameter.location !== undefined)
          .map((parameter) => ({
            location: parameter.location!,
            name: parameter.name,
            type: parameter.type
          }))
      )
  ]);
  const fragmentOutputs = canonicalStageIo([
    ...ir.globals
      .filter((value) => value.addressSpace === 'out' && value.location !== undefined)
      .map((value) => ({ location: value.location!, name: value.name, type: value.type })),
    ...ir.entryPoints
      .filter((entry) => entry.stage === 'fragment' && entry.returnType !== undefined)
      .map((entry) => ({
        location: entry.returnLocation ?? 0,
        name: entry.name,
        type: entry.returnType!
      }))
  ]);
  const data = { shaderAbiVersion, target, groups, buffers, vertexInputs, fragmentOutputs };
  return Object.freeze({
    shaderAbiVersion,
    groups: Object.freeze(groups),
    buffers: Object.freeze(buffers),
    vertexInputs: Object.freeze(vertexInputs),
    fragmentOutputs: Object.freeze(fragmentOutputs),
    layoutHash: stableHash(data)
  });
}

function canonicalStageIo(
  entries: readonly Readonly<{ location: number; name: string; type: string }>[]
) {
  const locations = new Map<number, Readonly<{ location: number; name: string; type: string }>>();
  for (const entry of entries) {
    const previous = locations.get(entry.location);
    if (previous !== undefined) {
      if (previous.name !== entry.name || previous.type !== entry.type) {
        throw new Error(`Shader stage IO location ${entry.location} has conflicting declarations.`);
      }
      continue;
    }
    locations.set(entry.location, Object.freeze({ ...entry }));
  }
  return [...locations.values()].sort(compareStageIo);
}

function bindingVisibility(ir: ShaderModuleIR): readonly ShaderStage[] {
  const stages = new Set(ir.entryPoints.map(({ stage }) => stage));
  if (stages.size === 0) return Object.freeze(['vertex', 'fragment']);
  return Object.freeze(
    (['vertex', 'fragment', 'compute'] as const).filter((stage) => stages.has(stage))
  );
}

function compareStageIo(
  left: Readonly<{ location: number; name: string; type: string }>,
  right: Readonly<{ location: number; name: string; type: string }>
): number {
  return (
    left.location - right.location ||
    compareCodeUnits(left.name, right.name) ||
    compareCodeUnits(left.type, right.type)
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
