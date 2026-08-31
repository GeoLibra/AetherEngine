import { describe, expect, it } from 'vitest';
import {
  PipelineCache,
  createPipelineCompileRequest,
  resolvePipelineAvailability,
  type BoundMaterialPhaseItem,
  type PipelineAvailabilityIdentity
} from '../../src';
import { deferredSubmission, disposablePipeline } from './pipeline-cache-fixtures';

describe('pipeline availability submission retention', () => {
  it('keeps a selected pipeline alive through invalidation until submission completion', async () => {
    const pipeline = disposablePipeline(301);
    const cache = new PipelineCache({
      compile: async () => ({ status: 'success', pipeline })
    });
    cache.request(
      createPipelineCompileRequest({
        pipelineKey: 'pipeline:a',
        requestRevision: 1,
        shaderRevision: 1,
        layoutRevision: 1,
        featurePolicyHash: 'policy:a',
        deviceGeneration: 4
      })
    );
    await flushCompilation();
    const lease = cache.acquireReady('pipeline:a')!;
    const result = resolvePipelineAvailability({
      bound: BOUND,
      identity: IDENTITY,
      primary: cache.snapshot('pipeline:a'),
      primaryLease: lease
    });
    if (result.status !== 'ready') throw new Error(`Unexpected skip: ${result.code}`);
    const submission = deferredSubmission(30);
    result.pipelineLease.retain(submission.value);

    cache.invalidate('pipeline:a', 'shader-revision-changed');
    result.pipelineLease.release();

    expect(pipeline.dispose).not.toHaveBeenCalled();
    submission.resolve({ status: 'completed' });
    await submission.value.done;
    await Promise.resolve();
    expect(pipeline.dispose).toHaveBeenCalledOnce();
  });
});

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

async function flushCompilation(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
