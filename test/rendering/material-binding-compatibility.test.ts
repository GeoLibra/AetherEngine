import { describe, expect, test } from 'vitest';
import {
  compileMaterialBindingLayout,
  compileBindingLayoutPlan,
  createMaterialParameterBlock,
  createShaderBindingManifest,
  defineMaterialSchema,
  resolveMaterialBindingCompatibility,
  type MaterialResourceResolver,
  type PhaseItem,
  type RenderEntityId,
  type ResolvedMaterialPipelineCandidate,
  type ResolvedMaterialResource,
  type ShaderModuleIR
} from '../../src';

const span = {
  uri: 'asset://shader/binding-compatibility',
  line: 1,
  column: 1,
  length: 1
} as const;

describe('Material binding compatibility', () => {
  test('binds an unbound phase item with a canonical key and enables safe opaque batching', () => {
    const first = request(1, texture('requested'));
    const second = request(2, texture('requested'));
    const result = resolveMaterialBindingCompatibility('main', 'opaque', [first, second]);

    expect(result.skipped).toEqual([]);
    expect(result.bound).toHaveLength(2);
    expect(result.bound[0]?.item.bindingKey).toBe(result.bound[0]?.bindingKey.hash);
    expect(result.bound[0]?.bindingKey.hash).toBe(result.bound[1]?.bindingKey.hash);
    expect(result.bound[0]?.bindingKey.parts.bindingLayoutHash).toBe(first.bindingPlan.hash);
    expect(result.snapshot.batches).toHaveLength(1);
    expect(first.item.bindingKey).toBeUndefined();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.bound[0]?.item)).toBe(true);
  });

  test('includes allocation and resource generations in binding compatibility', () => {
    const first = request(1, texture('requested'));
    const allocationChanged = request(2, texture('requested'), { dynamicOffsets: [256] });
    const resourceChanged = request(3, texture('requested', { resourceGeneration: 2 }));
    const result = resolveMaterialBindingCompatibility('main', 'opaque', [
      first,
      allocationChanged,
      resourceChanged
    ]);

    expect(new Set(result.bound.map(({ bindingKey }) => bindingKey.hash))).toHaveLength(3);
    expect(result.snapshot.batches).toHaveLength(3);
  });

  test('maps expected resource failures to typed skips with original diagnostics', () => {
    const missing = request(1, undefined);
    const pending = request(2, texture('requested', { ready: false }));
    const stale = request(3, texture('requested', { deviceGeneration: 2 }));
    const result = resolveMaterialBindingCompatibility('main', 'opaque', [missing, pending, stale]);

    expect(result.bound).toEqual([]);
    expect(result.skipped.map(({ code }) => code)).toEqual([
      'binding-resource-missing',
      'binding-resource-not-ready',
      'binding-device-generation-stale'
    ]);
    expect(result.skipped[0]?.diagnostics[0]?.code).toBe('missing-resource');
    expect(result.skipped[1]?.diagnostics[0]?.code).toBe('resource-not-ready');
    expect(result.skipped[2]?.diagnostics[0]?.code).toBe('device-generation-mismatch');
  });

  test('returns a typed skip for invalid allocation facts', () => {
    const invalid = request(1, texture('requested'), { dynamicOffsets: [-1] });
    const result = resolveMaterialBindingCompatibility('main', 'opaque', [invalid]);

    expect(result.bound).toEqual([]);
    expect(result.skipped).toMatchObject([{ code: 'binding-allocation-invalid' }]);
  });

  test('rejects malformed association and already-bound inputs at the public boundary', () => {
    const malformed = request(1, texture('ready'));
    expect(() => resolveMaterialBindingCompatibility('main', 'transparent', [malformed])).toThrow(
      'phase'
    );
    expect(() =>
      resolveMaterialBindingCompatibility('main', 'opaque', [
        { ...malformed, item: { ...malformed.item, bindingKey: 'existing' } }
      ])
    ).toThrow('unbound');
    expect(() =>
      resolveMaterialBindingCompatibility('main', 'opaque', [
        {
          ...malformed,
          bindingPlan: { ...malformed.bindingPlan, sourceLayoutHash: 'different-layout' }
        }
      ])
    ).toThrow('canonical binding plan');
  });
});

function request(
  entity: number,
  resource: ResolvedMaterialResource | undefined,
  allocationOverrides: Partial<{
    bufferAllocationGeneration: number;
    ringGeneration: number;
    dynamicOffsets: readonly number[];
    deviceGeneration: number;
  }> = {}
) {
  const schema = defineMaterialSchema({
    id: 'material.binding-compatibility',
    version: 1,
    fields: {
      texture: {
        fieldId: 'texture',
        name: 'texture',
        valueType: { kind: 'texture-reference' },
        defaultValue: { kind: 'texture', assetId: 'requested' },
        bindingPath: 'surfaceTexture'
      }
    }
  });
  const parameters = createMaterialParameterBlock(schema).with(schema.fields.texture, {
    kind: 'texture',
    assetId: 'requested'
  });
  const manifest = createShaderBindingManifest(
    emptyIr([
      {
        name: 'surfaceTexture',
        type: 'texture_2d<f32>',
        addressSpace: 'handle',
        access: 'read',
        group: 1,
        binding: 0,
        span
      }
    ]),
    1
  );
  const layout = compileMaterialBindingLayout(schema, manifest);
  const bindingPlanResult = compileBindingLayoutPlan(manifest);
  if (bindingPlanResult.kind !== 'success') throw new Error(bindingPlanResult.diagnostic.message);
  const item: PhaseItem = {
    entity: entity as RenderEntityId,
    phase: 'opaque',
    pipelineKey: 'pipeline',
    materialKey: 'material',
    meshKey: 'mesh',
    drawKey: 'draw',
    distance: entity,
    insertionOrder: entity
  };
  const resolver: MaterialResourceResolver = {
    deviceGeneration: 3,
    resolve: () => resource
  };
  return {
    item,
    candidate: {
      candidate: { entity: entity as RenderEntityId },
      pipelineKey: { parts: { bindingLayoutHash: layout.shaderLayoutHash, deviceGeneration: 3 } }
    } as ResolvedMaterialPipelineCandidate,
    layout,
    bindingPlan: bindingPlanResult.plan,
    supplied: parameters,
    resolver,
    allocation: {
      bufferAllocationGeneration: 0,
      ringGeneration: 0,
      dynamicOffsets: [],
      deviceGeneration: 3,
      ...allocationOverrides
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

function emptyIr(globals: ShaderModuleIR['globals']): ShaderModuleIR {
  return {
    version: 1,
    types: [],
    globals,
    functions: [],
    entryPoints: [],
    variants: [],
    sourceMap: { spans: [] },
    sourceClosureHash: 'binding-compatibility'
  };
}
