import {
  PipelineCache,
  resolvePipelineAvailability,
  type BoundMaterialPhaseItem,
  type PipelineAvailabilityIdentity,
  type PipelineCacheEntryState,
  type PipelineInterestLease,
  type PipelineReadyLease,
  type RenderEntityId
} from '../../src';
import type { RHIRenderPipeline } from '../../src/rhi/contracts';
import { observation } from './reference';
import type { MaterialScenarioCase, MaterialScenarioObservation } from './types';

export interface PipelineCacheResolutionOptions {
  readonly itemCount: number;
  readonly uniqueKeys: number;
  readonly concurrentRequests: number;
}

const PRIMARY_PIPELINE = Object.freeze({ id: 301 }) as unknown as RHIRenderPipeline;
const FALLBACK_PIPELINE = Object.freeze({ id: 302 }) as unknown as RHIRenderPipeline;
const IDENTITY: PipelineAvailabilityIdentity = Object.freeze({
  phase: 'opaque',
  semanticTag: 'main-color',
  bindingLayoutHash: 'layout',
  vertexLayoutHash: 'vertex',
  attachmentFormats: Object.freeze(['rgba8unorm']),
  depthStencilFormat: 'depth24plus',
  sampleCount: 1,
  featurePolicyHash: 'policy',
  backendTarget: 'webgpu',
  deviceGeneration: 1
});

export function createPipelineCacheResolutionCase(
  options: PipelineCacheResolutionOptions
): MaterialScenarioCase {
  validateOptions(options);
  const semantic = referenceSemantic(options);
  const compileRequests = options.uniqueKeys * options.concurrentRequests;
  const referenceCounters = Object.freeze({
    queueItems: options.itemCount,
    uniqueKeys: options.uniqueKeys,
    compileRequests,
    duplicateRequests: 0,
    compileStarts: compileRequests,
    synchronousCompiles: compileRequests,
    stalePublish: 0,
    staleReuse: 0
  });
  const subjectCounters = Object.freeze({
    queueItems: options.itemCount,
    uniqueKeys: options.uniqueKeys,
    compileRequests,
    duplicateRequests: options.uniqueKeys * (options.concurrentRequests - 1),
    compileStarts: 0,
    synchronousCompiles: 0,
    stalePublish: 0,
    staleReuse: 0
  });
  return Object.freeze({
    scenarioId: 'pipeline-cache-resolution-v1',
    scenarioVersion: 1,
    caseId: `items-${options.itemCount}-keys-${options.uniqueKeys}-requests-${options.concurrentRequests}`,
    scale: Object.freeze({ ...options }),
    expected: Object.freeze({ reference: referenceCounters, subject: subjectCounters }),
    runReference: () => observation(semantic, referenceCounters),
    runSubject: () => runSubject(options)
  });
}

function runSubject(options: PipelineCacheResolutionOptions): MaterialScenarioObservation {
  const cache = new PipelineCache({
    compile: async () => {
      throw new Error('Pipeline cache benchmark must not compile synchronously.');
    }
  });
  const leases: PipelineInterestLease[] = [];
  for (let keyIndex = 0; keyIndex < options.uniqueKeys; keyIndex += 1) {
    for (let requestIndex = 0; requestIndex < options.concurrentRequests; requestIndex += 1) {
      leases.push(
        cache.request({
          pipelineKey: `pipeline:${keyIndex}`,
          requestRevision: 1,
          shaderRevision: 1,
          layoutRevision: 1,
          featurePolicyHash: 'policy',
          deviceGeneration: 1
        })
      );
    }
  }
  const counts = {
    readyItems: 0,
    fallbackItems: 0,
    compilingSkips: 0,
    errorSkips: 0,
    staleSkips: 0
  };
  for (let itemIndex = 0; itemIndex < options.itemCount; itemIndex += 1) {
    const keyIndex = itemIndex % options.uniqueKeys;
    const primary = stateFor(keyIndex);
    const result = resolvePipelineAvailability({
      bound: boundItem(itemIndex, keyIndex),
      identity: IDENTITY,
      primary,
      ...(primary.kind === 'ready'
        ? { primaryLease: readyLease(`pipeline:${keyIndex}`, primary.pipeline) }
        : {}),
      ...(keyIndex % 4 === 1
        ? {
            fallback: {
              identity: IDENTITY,
              state: { kind: 'ready', pipeline: FALLBACK_PIPELINE, deviceGeneration: 1 },
              lease: readyLease('pipeline:fallback', FALLBACK_PIPELINE)
            } as const
          }
        : {})
    });
    if (result.status === 'ready') {
      if (result.selection === 'primary') counts.readyItems += 1;
      else counts.fallbackItems += 1;
    } else if (result.code === 'pipeline-compiling') counts.compilingSkips += 1;
    else if (result.code === 'pipeline-error') counts.errorSkips += 1;
    else if (result.code === 'device-generation-stale') counts.staleSkips += 1;
  }
  for (const lease of leases) lease.release();
  const metrics = cache.metrics();
  return observation(Object.freeze(counts), {
    queueItems: options.itemCount,
    uniqueKeys: options.uniqueKeys,
    compileRequests: leases.length,
    duplicateRequests: metrics.duplicateRequests,
    compileStarts: metrics.compileStarts,
    synchronousCompiles: 0,
    stalePublish: metrics.readyPublications,
    staleReuse: 0
  });
}

function readyLease(pipelineKey: string, pipeline: RHIRenderPipeline): PipelineReadyLease {
  return Object.freeze({
    pipelineKey,
    pipeline,
    deviceGeneration: 1,
    released: false,
    retain() {},
    release() {}
  });
}

function referenceSemantic(options: PipelineCacheResolutionOptions) {
  const counts = {
    readyItems: 0,
    fallbackItems: 0,
    compilingSkips: 0,
    errorSkips: 0,
    staleSkips: 0
  };
  for (let index = 0; index < options.itemCount; index += 1) {
    const category = (index % options.uniqueKeys) % 4;
    if (category === 0) counts.readyItems += 1;
    else if (category === 1) counts.fallbackItems += 1;
    else if (category === 2) counts.errorSkips += 1;
    else counts.staleSkips += 1;
  }
  return Object.freeze(counts);
}

function stateFor(keyIndex: number): PipelineCacheEntryState {
  const category = keyIndex % 4;
  if (category === 0)
    return Object.freeze({ kind: 'ready', pipeline: PRIMARY_PIPELINE, deviceGeneration: 1 });
  if (category === 1) return Object.freeze({ kind: 'queued', requestId: `request:${keyIndex}` });
  if (category === 2)
    return Object.freeze({
      kind: 'errored',
      diagnostic: Object.freeze({ code: 'shader-invalid', message: 'Shader invalid.' }),
      retry: 'input-change'
    });
  return Object.freeze({ kind: 'stale', reason: 'device-generation-changed' });
}

function boundItem(itemIndex: number, keyIndex: number): BoundMaterialPhaseItem {
  return Object.freeze({
    item: Object.freeze({
      entity: itemIndex as RenderEntityId,
      phase: 'opaque',
      pipelineKey: `pipeline:${keyIndex}`,
      materialKey: 'material',
      meshKey: 'mesh',
      bindingKey: 'binding',
      drawKey: 'draw',
      distance: itemIndex,
      insertionOrder: itemIndex
    })
  }) as unknown as BoundMaterialPhaseItem;
}

function validateOptions(options: PipelineCacheResolutionOptions): void {
  for (const [name, value] of [
    ['item count', options.itemCount],
    ['unique key count', options.uniqueKeys],
    ['concurrent request count', options.concurrentRequests]
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`Pipeline cache benchmark ${name} must be a positive safe integer.`);
  if (options.uniqueKeys > options.itemCount)
    throw new Error('Pipeline cache benchmark unique keys cannot exceed item count.');
}
