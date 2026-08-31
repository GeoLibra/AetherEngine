import { describe, expect, it } from 'vitest';
import {
  resolvePipelineAvailability,
  type BoundMaterialPhaseItem,
  type PipelineAvailabilityIdentity,
  type PipelineCacheEntryState,
  type PipelineReadyLease
} from '../../src';
import type { RHIRenderPipeline } from '../../src/rhi/contracts';

const PRIMARY_PIPELINE = Object.freeze({ id: 201 }) as unknown as RHIRenderPipeline;
const FALLBACK_PIPELINE = Object.freeze({ id: 202 }) as unknown as RHIRenderPipeline;

const IDENTITY: PipelineAvailabilityIdentity = Object.freeze({
  phase: 'opaque',
  semanticTag: 'main-color',
  bindingLayoutHash: 'layout:a',
  vertexLayoutHash: 'vertex:a',
  attachmentFormats: Object.freeze(['rgba8unorm']),
  depthStencilFormat: 'depth24plus',
  sampleCount: 1,
  featurePolicyHash: 'policy:a',
  backendTarget: 'webgpu',
  deviceGeneration: 4
});

const BOUND = Object.freeze({
  item: Object.freeze({
    entity: 7,
    phase: 'opaque',
    pipelineKey: 'pipeline:a',
    materialKey: 'material:a',
    meshKey: 'mesh:a',
    bindingKey: 'binding:a',
    drawKey: 'draw:a',
    distance: 1,
    insertionOrder: 0
  })
}) as unknown as BoundMaterialPhaseItem;

function resolve(
  primary: PipelineCacheEntryState,
  primaryLease?: PipelineReadyLease,
  fallback?: Readonly<{
    identity: PipelineAvailabilityIdentity;
    state: PipelineCacheEntryState;
    lease?: PipelineReadyLease;
  }>
) {
  return resolvePipelineAvailability({
    bound: BOUND,
    identity: IDENTITY,
    primary,
    ...(primaryLease === undefined ? {} : { primaryLease }),
    ...(fallback === undefined ? {} : { fallback })
  });
}

describe('pipeline availability', () => {
  it('publishes a ready primary pipeline without invoking asynchronous work', () => {
    const lease = pipelineLease('pipeline:a', PRIMARY_PIPELINE);
    const result = resolve(
      { kind: 'ready', pipeline: PRIMARY_PIPELINE, deviceGeneration: 4 },
      lease
    );

    expect(result).toEqual({
      status: 'ready',
      bound: BOUND,
      pipeline: PRIMARY_PIPELINE,
      pipelineLease: lease,
      selection: 'primary'
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('returns a typed stale skip when a ready snapshot has no ownership lease', () => {
    expect(resolve({ kind: 'ready', pipeline: PRIMARY_PIPELINE, deviceGeneration: 4 })).toEqual({
      status: 'skipped',
      entity: 7,
      reason: 'pipeline-unavailable',
      code: 'device-generation-stale'
    });
  });

  it.each(['absent', 'queued', 'compiling'] as const)(
    'uses an exactly compatible ready fallback while primary is %s',
    (kind) => {
      const primary =
        kind === 'absent'
          ? ({ kind } as const)
          : kind === 'queued'
            ? ({ kind, requestId: 'request:a' } as const)
            : ({ kind, requestId: 'request:a', startedAt: 1 } as const);

      expect(
        resolve(primary, undefined, {
          identity: IDENTITY,
          state: { kind: 'ready', pipeline: FALLBACK_PIPELINE, deviceGeneration: 4 },
          lease: pipelineLease('pipeline:fallback', FALLBACK_PIPELINE)
        })
      ).toMatchObject({ status: 'ready', pipeline: FALLBACK_PIPELINE, selection: 'fallback' });
    }
  );

  it('returns pipeline-compiling when no fallback is declared', () => {
    expect(resolve({ kind: 'queued', requestId: 'request:a' })).toEqual({
      status: 'skipped',
      entity: 7,
      reason: 'pipeline-unavailable',
      code: 'pipeline-compiling'
    });
  });

  it('preserves a cached pipeline diagnostic', () => {
    expect(
      resolve({
        kind: 'errored',
        diagnostic: { code: 'shader-invalid', message: 'Shader validation failed.' },
        retry: 'input-change'
      })
    ).toEqual({
      status: 'skipped',
      entity: 7,
      reason: 'pipeline-unavailable',
      code: 'pipeline-error',
      diagnostic: { code: 'shader-invalid', message: 'Shader validation failed.' }
    });
  });

  it('rejects a fallback when any compatibility dimension differs', () => {
    const fallbackIdentity = Object.freeze({ ...IDENTITY, sampleCount: 4 });

    expect(
      resolve({ kind: 'queued', requestId: 'request:a' }, undefined, {
        identity: fallbackIdentity,
        state: { kind: 'ready', pipeline: FALLBACK_PIPELINE, deviceGeneration: 4 }
      })
    ).toEqual({
      status: 'skipped',
      entity: 7,
      reason: 'pipeline-unavailable',
      code: 'fallback-incompatible'
    });
  });

  it('reports device-generation-stale for stale cache or ready pipeline facts', () => {
    expect(resolve({ kind: 'stale', reason: 'device-generation-changed' })).toMatchObject({
      status: 'skipped',
      code: 'device-generation-stale'
    });
    expect(
      resolve(
        { kind: 'ready', pipeline: PRIMARY_PIPELINE, deviceGeneration: 3 },
        pipelineLease('pipeline:a', PRIMARY_PIPELINE)
      )
    ).toMatchObject({ status: 'skipped', code: 'device-generation-stale' });
  });

  it('validates the bound item and identity phase association', () => {
    const mismatched = {
      ...BOUND,
      item: { ...BOUND.item, phase: 'transparent' as const }
    } as BoundMaterialPhaseItem;

    expect(() =>
      resolvePipelineAvailability({
        bound: mismatched,
        identity: IDENTITY,
        primary: { kind: 'absent' }
      })
    ).toThrow('Pipeline availability phase mismatch.');
  });
});

function pipelineLease(pipelineKey: string, pipeline: RHIRenderPipeline): PipelineReadyLease {
  return Object.freeze({
    pipelineKey,
    pipeline,
    deviceGeneration: 4,
    released: false,
    retain() {},
    release() {}
  });
}
