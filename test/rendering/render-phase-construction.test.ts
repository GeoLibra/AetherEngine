import { describe, expect, test } from 'vitest';
import {
  buildRenderPhase,
  constructRenderPhase,
  createPipelineKey,
  type MaterialPipelineCompatibilityResult,
  type PreparedAssetLease,
  type PreparedMaterialCompatibility,
  type PreparedMesh,
  type RenderEntityId,
  type ResolvedMaterialPipelineCandidate
} from '../../src';

function resolved(
  entity: number,
  surface: 'opaque' | 'alpha-mask' | 'transparent' = 'opaque',
  depthRange: readonly [number, number] = [-4, -2]
): ResolvedMaterialPipelineCandidate {
  const lease = <T>(assetId: string, value: T): PreparedAssetLease<T> =>
    Object.freeze({
      prepared: Object.freeze({
        key: Object.freeze({
          assetId,
          payloadVersion: 1,
          deviceGeneration: 2,
          featurePolicyKey: 'policy',
          abiVersion: 'v1'
        }),
        value
      }),
      disposed: false,
      retainUntil: () => undefined,
      dispose: () => undefined
    });
  const mesh = lease<PreparedMesh>('mesh:a', {
    deviceGeneration: 2,
    layout: { topology: 'triangles', frontFace: 'ccw', streams: [] },
    vertexBuffers: [],
    submeshes: [{ start: 0, count: 3, materialSlot: 0 }],
    byteLength: 0
  });
  const material = lease<PreparedMaterialCompatibility>('material:a', {
    deviceGeneration: 2,
    asset: { id: 'material:a' } as PreparedMaterialCompatibility['asset'],
    bindingLayoutHash: 'layout',
    selectedVariant: 'base',
    availableMaterialFeatures: []
  });
  return {
    candidate: { entity: entity as RenderEntityId, depthRange, submesh: 0, mesh, material },
    selection: {
      status: 'selected',
      technique: { name: 'main' } as ResolvedMaterialPipelineCandidate['selection']['technique'],
      requestedRole: 'main' as ResolvedMaterialPipelineCandidate['selection']['requestedRole'],
      selectedRole: 'main' as ResolvedMaterialPipelineCandidate['selection']['selectedRole'],
      candidatesExamined: 1
    },
    renderState: {
      status: 'resolved',
      phase: surface === 'transparent' ? 'transparent' : 'opaque',
      surface,
      depthTest: true,
      depthWrite: surface !== 'transparent',
      colorWrite: true,
      cullMode: 'back',
      blend: undefined
    },
    pipelineKey: createPipelineKey({
      shaderModuleKey: 'shader',
      entryPoints: [{ stage: 'vertex', name: 'main' }],
      bindingLayoutHash: 'layout',
      vertexLayoutHash: 'vertex',
      primitiveStateHash: 'primitive',
      depthStencilStateHash: 'depth',
      blendStateHash: 'blend',
      attachmentFormats: ['rgba8unorm'],
      sampleCount: 1,
      featurePolicyHash: 'policy',
      deviceGeneration: 2
    })
  };
}

describe('render phase construction', () => {
  test('constructs immutable canonical unbound items and preserves upstream skips', () => {
    const upstream = Object.freeze({
      entity: 9 as RenderEntityId,
      reason: 'incompatible-pipeline' as const,
      code: 'layout-incompatible' as const,
      diagnostic: Object.freeze({ code: 'layout-incompatible' as const, message: 'layout' })
    });
    const compatibility: MaterialPipelineCompatibilityResult = {
      resolved: [resolved(1)],
      skipped: [upstream]
    };
    const result = constructRenderPhase({ viewId: 'main', phase: 'opaque' }, compatibility);

    expect(result.snapshot.items[0]).toMatchObject({
      entity: 1,
      phase: 'opaque',
      distance: 3,
      insertionOrder: 0
    });
    expect(result.snapshot.items[0]?.bindingKey).toBeUndefined();
    expect(result.snapshot.items[0]?.pipelineKey).toBe(compatibility.resolved[0]?.pipelineKey.hash);
    expect(result.snapshot.items[0]?.meshKey).toContain('mesh:a');
    expect(result.snapshot.items[0]?.materialKey).toContain('material:a');
    expect(result.skipped[0]).toBe(upstream);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.snapshot.items[0])).toBe(true);
  });

  test('returns typed skips for incompatible surfaces and invalid borrowed facts', () => {
    const transparent = constructRenderPhase(
      { viewId: 'main', phase: 'opaque' },
      { resolved: [resolved(1, 'transparent')], skipped: [] }
    );
    const invalidDepth = constructRenderPhase(
      { viewId: 'main', phase: 'opaque' },
      { resolved: [resolved(2, 'opaque', [Number.NaN, 1])], skipped: [] }
    );

    expect(transparent.skipped[0]?.code).toBe('incompatible-phase-surface');
    expect(invalidDepth.skipped[0]?.code).toBe('invalid-borrowed-candidate');
    expect(() =>
      constructRenderPhase({ viewId: '', phase: 'opaque' }, { resolved: [], skipped: [] })
    ).toThrow('view ID must be non-empty');
  });

  test('keeps unbound batches separate and uses phase-specific deterministic ordering', () => {
    const result = constructRenderPhase(
      { viewId: 'main', phase: 'opaque' },
      { resolved: [resolved(2), resolved(1)], skipped: [] }
    );
    expect(result.snapshot.items.map(({ entity }) => entity)).toEqual([1, 2]);
    expect(result.snapshot.batches).toHaveLength(2);

    const transparent = constructRenderPhase(
      { viewId: 'main', phase: 'transparent' },
      {
        resolved: [resolved(1, 'transparent', [-2, -1]), resolved(2, 'transparent', [-8, -6])],
        skipped: []
      }
    );
    expect(transparent.snapshot.items.map(({ entity }) => entity)).toEqual([2, 1]);
    expect(transparent.snapshot.batches).toHaveLength(2);
  });

  test('retains batching for callers that provide complete binding identity', () => {
    const base = {
      entity: 1 as RenderEntityId,
      phase: 'opaque' as const,
      pipelineKey: 'p',
      materialKey: 'm',
      meshKey: 'mesh',
      bindingKey: 'binding',
      drawKey: 'draw',
      distance: 0,
      insertionOrder: 0
    };
    expect(
      buildRenderPhase('main', 'opaque', [base, { ...base, entity: 2 as RenderEntityId }]).batches
    ).toHaveLength(1);
  });
});
