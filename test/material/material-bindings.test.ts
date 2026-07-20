import { describe, expect, test } from 'vitest';
import {
  MaterialDiagnosticError,
  compileMaterialBindingLayout,
  createMaterialParameterBlock,
  createShaderBindingManifest,
  defineMaterialSchema,
  resolveMaterialBindings,
  type MaterialParameterBlock,
  type MaterialResourceResolver,
  type ResolvedMaterialResource,
  type ShaderBindingManifest,
  type ShaderModuleIR,
  type ShaderSamplerBindingRequirement
} from '../../src';

const span = { uri: 'asset://shader/material', line: 1, column: 1, length: 1 } as const;

describe('Material binding layout', () => {
  test('compiles resource fields from the single typed Shader binding manifest', () => {
    const schema = defineBindingSchema();
    const layout = compileMaterialBindingLayout(schema, createBindingManifest());

    expect(layout.entries).toEqual([
      expect.objectContaining({
        fieldId: 'albedo',
        bindingPath: 'albedoTexture',
        kind: 'texture',
        group: 1,
        binding: 0,
        viewDimension: '2d',
        sampleType: 'float',
        multisampled: false
      }),
      expect.objectContaining({
        fieldId: 'surface-sampler',
        bindingPath: 'surfaceSampler',
        kind: 'sampler',
        group: 1,
        binding: 1,
        samplerType: 'filtering'
      })
    ]);
    expect(Object.isFrozen(layout)).toBe(true);
    expect(Object.isFrozen(layout.entries)).toBe(true);
  });

  test('diagnoses missing, duplicate and kind-mismatched binding paths separately', () => {
    const missing = defineMaterialSchema({
      id: 'aether.material.binding-missing',
      version: 1,
      fields: {
        texture: textureField('texture', 'notPresent', 'texture-default')
      }
    });
    expectCompileDiagnostic(
      () => compileMaterialBindingLayout(missing, createBindingManifest()),
      'missing-binding'
    );

    const duplicateManifest = createBindingManifest({ duplicateTextureName: true });
    const duplicate = defineMaterialSchema({
      id: 'aether.material.binding-duplicate',
      version: 1,
      fields: {
        texture: textureField('texture', 'albedoTexture', 'texture-default')
      }
    });
    expectCompileDiagnostic(
      () => compileMaterialBindingLayout(duplicate, duplicateManifest),
      'compile-failure'
    );

    const wrongKind = defineMaterialSchema({
      id: 'aether.material.binding-kind',
      version: 1,
      fields: {
        texture: textureField('texture', 'surfaceSampler', 'texture-default')
      }
    });
    expectCompileDiagnostic(
      () => compileMaterialBindingLayout(wrongKind, createBindingManifest()),
      'binding-kind-mismatch'
    );
  });
});

describe('Material binding resolution matrix', () => {
  test('selects ready supplied resources', () => {
    const fixture = createResolutionFixture();
    const result = resolveMaterialBindings(
      fixture.layout,
      fixture.supplied,
      fixture.defaults,
      resolver([texture('texture-supplied'), sampler('sampler-supplied')])
    );

    expect(result).toEqual({
      status: 'ready',
      resources: [texture('texture-supplied'), sampler('sampler-supplied')],
      diagnostics: []
    });
  });

  test.each([
    {
      label: 'missing',
      suppliedTexture: undefined,
      diagnostic: 'missing-resource'
    },
    {
      label: 'non-ready',
      suppliedTexture: texture('texture-supplied', { ready: false }),
      diagnostic: 'resource-not-ready'
    }
  ])('uses a compatible schema default for a $label supplied resource', (entry) => {
    const fixture = createResolutionFixture();
    const resources = [texture('texture-default'), sampler('sampler-supplied')];
    if (entry.suppliedTexture !== undefined) resources.push(entry.suppliedTexture);
    const result = resolveMaterialBindings(
      fixture.layout,
      fixture.supplied,
      fixture.defaults,
      resolver(resources)
    );

    expect(result.status).toBe('ready');
    expect(result.resources.map((resource) => resource.id)).toEqual([
      'texture-default',
      'sampler-supplied'
    ]);
    expect(result.diagnostics).toMatchObject([{ code: entry.diagnostic, field: 'albedo' }]);
  });

  test('returns unsupported when a missing supplied resource has no schema default', () => {
    const fixture = createResolutionFixture();
    const result = resolveMaterialBindings(
      fixture.layout,
      fixture.supplied,
      undefined,
      resolver([sampler('sampler-supplied')])
    );

    expect(result.status).toBe('unsupported');
    expect(result.resources.map((resource) => resource.id)).toEqual(['sampler-supplied']);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'missing-resource',
      'missing-resource'
    ]);
  });

  test('runs a default through the identical compatibility validator', () => {
    const fixture = createResolutionFixture();
    const incompatibleDefault = texture('texture-default', { viewDimension: 'cube' });
    const result = resolveMaterialBindings(
      fixture.layout,
      fixture.supplied,
      fixture.defaults,
      resolver([incompatibleDefault, sampler('sampler-supplied')])
    );

    expect(result.status).toBe('unsupported');
    expect(result.resources.map((resource) => resource.id)).toEqual(['sampler-supplied']);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'missing-resource',
      'texture-dimension-mismatch'
    ]);
  });

  test.each([
    {
      label: 'binding kind',
      resource: sampler('texture-supplied'),
      diagnostic: 'binding-kind-mismatch'
    },
    {
      label: 'texture dimension',
      resource: texture('texture-supplied', { viewDimension: 'cube' }),
      diagnostic: 'texture-dimension-mismatch'
    },
    {
      label: 'texture sample type',
      resource: texture('texture-supplied', { sampleType: 'depth' }),
      diagnostic: 'texture-sample-type-mismatch'
    },
    {
      label: 'texture multisampling',
      resource: texture('texture-supplied', { multisampled: true }),
      diagnostic: 'texture-multisample-mismatch'
    },
    {
      label: 'device generation',
      resource: texture('texture-supplied', { deviceGeneration: 2 }),
      diagnostic: 'device-generation-mismatch'
    }
  ])('rejects a supplied $label mismatch without substituting a default', (entry) => {
    const fixture = createResolutionFixture();
    const result = resolveMaterialBindings(
      fixture.layout,
      fixture.supplied,
      fixture.defaults,
      resolver([entry.resource, texture('texture-default'), sampler('sampler-supplied')])
    );

    expect(result.status).toBe('unsupported');
    expect(result.resources.map((resource) => resource.id)).toEqual(['sampler-supplied']);
    expect(result.diagnostics).toMatchObject([{ code: entry.diagnostic, field: 'albedo' }]);
  });

  test.each([
    { expected: 'filtering', actual: 'non-filtering' },
    { expected: 'non-filtering', actual: 'comparison' },
    { expected: 'comparison', actual: 'filtering' }
  ] as const)('rejects a $actual sampler for a $expected binding', ({ expected, actual }) => {
    const fixture = createResolutionFixture(expected);
    const result = resolveMaterialBindings(
      fixture.layout,
      fixture.supplied,
      fixture.defaults,
      resolver([texture('texture-supplied'), sampler('sampler-supplied', { samplerType: actual })])
    );

    expect(result.status).toBe('unsupported');
    expect(result.resources.map((resource) => resource.id)).toEqual(['texture-supplied']);
    expect(result.diagnostics).toMatchObject([
      { code: 'sampler-type-mismatch', field: 'surfaceSampler' }
    ]);
  });
});

function defineBindingSchema() {
  return defineMaterialSchema({
    id: 'aether.material.binding-matrix',
    version: 1,
    fields: {
      albedo: textureField('albedo', 'albedoTexture', 'texture-default'),
      sampler: {
        fieldId: 'surface-sampler',
        name: 'surfaceSampler',
        valueType: { kind: 'sampler-reference' },
        defaultValue: { kind: 'sampler', assetId: 'sampler-default' },
        bindingPath: 'surfaceSampler'
      }
    }
  });
}

function textureField(fieldId: string, bindingPath: string, assetId: string) {
  return {
    fieldId,
    name: fieldId,
    valueType: { kind: 'texture-reference' } as const,
    defaultValue: { kind: 'texture', assetId } as const,
    bindingPath
  };
}

function createResolutionFixture(
  samplerType: 'filtering' | 'non-filtering' | 'comparison' = 'filtering'
) {
  const schema = defineBindingSchema();
  const defaults = createMaterialParameterBlock(schema);
  const supplied = defaults
    .with(schema.fields.albedo, { kind: 'texture', assetId: 'texture-supplied' })
    .with(schema.fields.sampler, { kind: 'sampler', assetId: 'sampler-supplied' });
  return {
    layout: compileMaterialBindingLayout(schema, createBindingManifest({ samplerType })),
    supplied,
    defaults
  };
}

function createBindingManifest(
  options: {
    readonly samplerType?: 'filtering' | 'non-filtering' | 'comparison';
    readonly duplicateTextureName?: boolean;
  } = {}
): ShaderBindingManifest {
  const samplerType = options.samplerType ?? 'filtering';
  const samplerSourceType = samplerType === 'comparison' ? 'sampler_comparison' : 'sampler';
  const globals: Array<ShaderModuleIR['globals'][number]> = [
    {
      name: 'albedoTexture',
      type: 'texture_2d<f32>',
      addressSpace: 'handle',
      access: 'read',
      group: 1,
      binding: 0,
      span
    },
    {
      name: 'surfaceSampler',
      type: samplerSourceType,
      addressSpace: 'handle',
      access: 'read',
      group: 1,
      binding: 1,
      span
    }
  ];
  if (options.duplicateTextureName === true) {
    globals.push({
      name: 'albedoTexture',
      type: 'texture_cube<f32>',
      addressSpace: 'handle',
      access: 'read',
      group: 2,
      binding: 0,
      span
    });
  }
  const requirement: readonly ShaderSamplerBindingRequirement[] =
    samplerType === 'non-filtering' ? [{ kind: 'sampler', group: 1, binding: 1, samplerType }] : [];
  return createShaderBindingManifest(emptyIr(globals), 1, 'wgsl', {
    bindingRequirements: requirement
  });
}

function emptyIr(globals: ShaderModuleIR['globals']): ShaderModuleIR {
  return {
    version: 1,
    types: [],
    globals,
    functions: [],
    entryPoints: [],
    variants: [],
    sourceMap: { spans: [] },
    sourceClosureHash: 'material-bindings'
  };
}

function resolver(resources: readonly ResolvedMaterialResource[]): MaterialResourceResolver {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  return {
    deviceGeneration: 3,
    resolve(reference) {
      return byId.get(reference.assetId);
    }
  };
}

function texture(
  id: string,
  overrides: Partial<Extract<ResolvedMaterialResource, { kind: 'texture' }>> = {}
): Extract<ResolvedMaterialResource, { kind: 'texture' }> {
  return Object.freeze({
    kind: 'texture',
    id,
    payloadVersion: 1,
    resourceGeneration: 1,
    deviceGeneration: 3,
    ready: true,
    viewDimension: '2d',
    sampleType: 'float',
    multisampled: false,
    ...overrides
  });
}

function sampler(
  id: string,
  overrides: Partial<Extract<ResolvedMaterialResource, { kind: 'sampler' }>> = {}
): Extract<ResolvedMaterialResource, { kind: 'sampler' }> {
  return Object.freeze({
    kind: 'sampler',
    id,
    payloadVersion: 1,
    resourceGeneration: 1,
    deviceGeneration: 3,
    ready: true,
    samplerType: 'filtering',
    ...overrides
  });
}

function expectCompileDiagnostic(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error('Expected MaterialDiagnosticError.');
  } catch (error) {
    expect(error).toBeInstanceOf(MaterialDiagnosticError);
    expect((error as MaterialDiagnosticError).diagnostic.code).toBe(code);
  }
}
