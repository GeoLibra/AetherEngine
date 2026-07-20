import type {
  ShaderBindingEntryManifest,
  ShaderBindingReflectionDiagnostic,
  ShaderModuleIR,
  ShaderSamplerBindingRequirement
} from './types';

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
