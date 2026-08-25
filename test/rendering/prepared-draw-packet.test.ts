import { describe, expect, test, vi } from 'vitest';
import {
  createBindingKey,
  prepareDrawPacket,
  type AvailablePipelinePhaseItem,
  type MaterialBindGroupCacheResolution,
  type PreparedMeshQueueCandidate
} from '../../src/rendering';
import type { RHIBuffer, RHISubmission, SubmissionResult } from '../../src/rhi/contracts';

describe('prepareDrawPacket', () => {
  test('joins exact pipeline, binding, mesh, and indexed submesh facts', () => {
    const fixture = drawFixture();

    const result = prepareDrawPacket(fixture.input);

    expect(result).toMatchObject({
      status: 'ready',
      packet: {
        entity: 7,
        phase: 'opaque',
        indexFormat: 'uint16',
        firstIndex: 3,
        indexCount: 6,
        vertexBuffers: fixture.vertexBuffers,
        indexBuffer: fixture.indexBuffer
      }
    });
    if (result.status !== 'ready') return;
    expect(Object.isFrozen(result.packet)).toBe(true);
  });

  test('retains every borrowed resource until submission and releases local cache ownership', () => {
    const fixture = drawFixture();
    const result = prepareDrawPacket(fixture.input);
    if (result.status !== 'ready') throw new Error(result.code);
    const submission = completedSubmission(11);

    result.packet.retain(submission);
    result.packet.release();
    result.packet.release();

    expect(fixture.pipelineRetain).toHaveBeenCalledWith(submission);
    expect(fixture.bindingRetain).toHaveBeenCalledWith(submission);
    expect(fixture.meshRetain).toHaveBeenCalledWith(submission);
    expect(fixture.materialRetain).toHaveBeenCalledWith(submission);
    expect(fixture.pipelineRelease).toHaveBeenCalledOnce();
    expect(fixture.bindingRelease).toHaveBeenCalledOnce();
    expect(result.packet.released).toBe(true);
  });

  test.each([
    [
      'draw-entity-mismatch',
      (fixture: ReturnType<typeof drawFixture>) => ({
        ...fixture.input,
        candidate: { ...fixture.input.candidate, entity: 8 }
      })
    ],
    [
      'binding-key-mismatch',
      (fixture: ReturnType<typeof drawFixture>) => {
        const bindingSet = {
          ...fixture.input.binding.bindingSet,
          bindingKey: createBindingKey({
            ...fixture.input.binding.bindingSet.bindingKey.parts,
            ringGeneration: 99
          })
        };
        return {
          ...fixture.input,
          binding: {
            ...fixture.input.binding,
            bindingSet,
            lease: { ...fixture.input.binding.lease, bindingSet }
          }
        };
      }
    ],
    [
      'indexed-draw-required',
      (fixture: ReturnType<typeof drawFixture>) => ({
        ...fixture.input,
        candidate: {
          ...fixture.input.candidate,
          mesh: fakePreparedLease({
            ...fixture.input.candidate.mesh.prepared.value,
            indexBuffer: undefined,
            layout: {
              ...fixture.input.candidate.mesh.prepared.value.layout,
              indexFormat: undefined
            }
          }).lease
        }
      })
    ]
  ] as const)('returns typed %s without retaining inputs', (code, mutate) => {
    const fixture = drawFixture();

    expect(prepareDrawPacket(mutate(fixture) as typeof fixture.input)).toMatchObject({
      status: 'skipped',
      code
    });
    expect(fixture.pipelineRetain).not.toHaveBeenCalled();
    expect(fixture.bindingRetain).not.toHaveBeenCalled();
  });
});

function drawFixture() {
  const bindingKey = createBindingKey({
    bindingLayoutHash: 'layout:a',
    resources: [],
    bufferAllocationGeneration: 1,
    ringGeneration: 1,
    dynamicOffsets: [],
    deviceGeneration: 4
  });
  const vertexBuffers = Object.freeze([{} as RHIBuffer]);
  const indexBuffer = {} as RHIBuffer;
  const pipelineRetain = vi.fn();
  const pipelineRelease = vi.fn();
  const bindingRetain = vi.fn();
  const bindingRelease = vi.fn();
  const pipeline = { generation: 4 } as never;
  const mesh = fakePreparedLease({
    deviceGeneration: 4,
    layout: { topology: 'triangles', frontFace: 'ccw', streams: [], indexFormat: 'uint16' },
    vertexBuffers,
    indexBuffer,
    submeshes: [{ start: 3, count: 6, materialSlot: 0 }],
    byteLength: 32
  });
  const material = fakePreparedLease({
    deviceGeneration: 4,
    asset: {} as never,
    bindingLayoutHash: 'layout:a',
    selectedVariant: 'base',
    availableMaterialFeatures: []
  });
  const availability = {
    status: 'ready',
    bound: {
      item: {
        entity: 7,
        phase: 'opaque',
        pipelineKey: 'pipeline:a',
        materialKey: 'material:a',
        meshKey: 'mesh:a',
        bindingKey: bindingKey.hash,
        drawKey: 'draw:a',
        distance: 1,
        insertionOrder: 0
      },
      bindingKey,
      diagnostics: []
    },
    pipeline,
    pipelineLease: {
      pipelineKey: 'pipeline:a',
      pipeline,
      deviceGeneration: 4,
      released: false,
      retain: pipelineRetain,
      release: pipelineRelease
    },
    selection: 'primary'
  } as unknown as AvailablePipelinePhaseItem;
  const bindingSet = {
    bindingKey,
    bindGroups: [],
    dynamicOffsets: [],
    deviceGeneration: 4
  };
  const binding = {
    status: 'hit',
    bindingSet,
    lease: {
      bindingSet,
      released: false,
      retain: bindingRetain,
      release: bindingRelease
    }
  } as MaterialBindGroupCacheResolution;
  const candidate = {
    entity: 7,
    depthRange: [0, 1],
    submesh: 0,
    mesh: mesh.lease,
    material: material.lease
  } as unknown as PreparedMeshQueueCandidate;
  return {
    input: { availability, binding, candidate },
    vertexBuffers,
    indexBuffer,
    pipelineRetain,
    pipelineRelease,
    bindingRetain,
    bindingRelease,
    meshRetain: mesh.retain,
    materialRetain: material.retain
  };
}

function fakePreparedLease<T>(value: T) {
  const retain = vi.fn();
  const lease = {
    prepared: {
      key: {
        assetId: 'asset:a',
        payloadVersion: 1,
        deviceGeneration: 4,
        featurePolicyKey: 'policy:a',
        abiVersion: 'abi:a'
      },
      value
    },
    disposed: false,
    retainUntil: retain,
    dispose: vi.fn()
  };
  return { lease, retain };
}

function completedSubmission(id: number): RHISubmission {
  const result: SubmissionResult = { status: 'completed' };
  return { id, status: 'completed', done: Promise.resolve(result) };
}
