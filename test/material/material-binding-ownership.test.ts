import { describe, expect, test } from 'vitest';
import {
  compileMaterialBindingLayout,
  createMaterialParameterBlock,
  defineMaterialSchema,
  resolveMaterialBindings,
  type ResolvedMaterialResource,
  type ShaderBindingManifest
} from '../../src';

describe('Material binding resolution ownership', () => {
  test('rejects a resolver result whose identity does not match the requested asset', () => {
    const fixture = createFixture();
    const result = resolveMaterialBindings(fixture.layout, fixture.supplied, fixture.defaults, {
      deviceGeneration: 3,
      resolve(reference) {
        return reference.kind === 'texture'
          ? texture('wrong-texture-id')
          : sampler('sampler-supplied');
      }
    });

    expect(result.status).toBe('unsupported');
    expect(result.resources.map((resource) => resource.id)).toEqual(['sampler-supplied']);
    expect(result.diagnostics).toMatchObject([{ code: 'missing-resource', field: 'albedo' }]);
  });

  test('returns owned deeply immutable snapshots of resolved runtime facts', () => {
    const fixture = createFixture();
    const rawTexture = texture('texture-supplied', 4);
    const rawSampler = sampler('sampler-supplied', 5);
    const result = resolveMaterialBindings(fixture.layout, fixture.supplied, fixture.defaults, {
      deviceGeneration: 3,
      resolve(reference) {
        return reference.kind === 'texture' ? rawTexture : rawSampler;
      }
    });
    rawTexture.id = 'mutated';
    rawTexture.resourceGeneration = 99;

    expect(result.status).toBe('ready');
    expect(result.resources[0]).toMatchObject({
      id: 'texture-supplied',
      resourceGeneration: 4
    });
    expect(result.resources.every((resource) => Object.isFrozen(resource))).toBe(true);
  });
});

function createFixture() {
  const schema = defineMaterialSchema({
    id: 'aether.material.binding-ownership',
    version: 1,
    fields: {
      albedo: {
        fieldId: 'albedo',
        name: 'albedo',
        valueType: { kind: 'texture-reference' },
        defaultValue: { kind: 'texture', assetId: 'texture-default' },
        bindingPath: 'albedoTexture'
      },
      sampler: {
        fieldId: 'surface-sampler',
        name: 'surfaceSampler',
        valueType: { kind: 'sampler-reference' },
        defaultValue: { kind: 'sampler', assetId: 'sampler-default' },
        bindingPath: 'surfaceSampler'
      }
    }
  });
  const defaults = createMaterialParameterBlock(schema);
  return {
    layout: compileMaterialBindingLayout(schema, manifest()),
    supplied: defaults
      .with(schema.fields.albedo, { kind: 'texture', assetId: 'texture-supplied' })
      .with(schema.fields.sampler, { kind: 'sampler', assetId: 'sampler-supplied' }),
    defaults
  };
}

function manifest(): ShaderBindingManifest {
  const entries = [
    {
      kind: 'texture' as const,
      group: 0,
      binding: 0,
      name: 'albedoTexture',
      viewDimension: '2d' as const,
      sampleType: 'float' as const,
      multisampled: false
    },
    {
      kind: 'sampler' as const,
      group: 0,
      binding: 1,
      name: 'surfaceSampler',
      samplerType: 'filtering' as const
    }
  ];
  return {
    shaderAbiVersion: 1,
    groups: [{ group: 0, visibility: ['vertex', 'fragment'], entries }],
    buffers: [],
    vertexInputs: [],
    fragmentOutputs: [],
    layoutHash: 'binding-ownership'
  };
}

function texture(id: string, resourceGeneration = 1) {
  return {
    kind: 'texture' as const,
    id,
    payloadVersion: 1,
    resourceGeneration,
    deviceGeneration: 3,
    ready: true,
    viewDimension: '2d' as const,
    sampleType: 'float' as const,
    multisampled: false
  } satisfies ResolvedMaterialResource;
}

function sampler(id: string, resourceGeneration = 1) {
  return {
    kind: 'sampler' as const,
    id,
    payloadVersion: 1,
    resourceGeneration,
    deviceGeneration: 3,
    ready: true,
    samplerType: 'filtering' as const
  } satisfies ResolvedMaterialResource;
}
