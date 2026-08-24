import { describe, expect, it, vi } from 'vitest';
import {
  PipelineCache,
  createPipelineCompileRequest,
  type PipelineCompileOutcome,
  type PipelineCompiler
} from '../../src';
import type { RHIRenderPipeline } from '../../src/rhi/contracts';
import { deferredSubmission, disposablePipeline } from './pipeline-cache-fixtures';

const UNUSED_COMPILER: PipelineCompiler = Object.freeze({
  compile: async () => {
    throw new Error('Compiler must not run during snapshot lookup.');
  }
});

const PIPELINE = Object.freeze({ id: 101 }) as unknown as RHIRenderPipeline;

function requestFor(pipelineKey = 'pipeline:a') {
  return createPipelineCompileRequest({
    pipelineKey,
    requestRevision: 1,
    shaderRevision: 2,
    layoutRevision: 3,
    featurePolicyHash: 'policy:a',
    deviceGeneration: 4
  });
}

function requestWith(
  override: Partial<ReturnType<typeof requestFor>>
): ReturnType<typeof requestFor> {
  return createPipelineCompileRequest({ ...requestFor(), ...override });
}

function deferredOutcome() {
  let resolve!: (outcome: PipelineCompileOutcome) => void;
  const promise = new Promise<PipelineCompileOutcome>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function flushCompilation(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('PipelineCache contracts', () => {
  it('publishes one shared immutable absent snapshot without invoking the compiler', () => {
    const cache = new PipelineCache(UNUSED_COMPILER);

    const first = cache.snapshot('pipeline:a');
    const second = cache.snapshot('pipeline:a');

    expect(first).toBe(second);
    expect(first).toEqual({ kind: 'absent' });
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('validates and snapshots caller-owned compile identity facts', () => {
    const input = {
      pipelineKey: 'pipeline:a',
      requestRevision: 1,
      shaderRevision: 2,
      layoutRevision: 3,
      featurePolicyHash: 'policy:a',
      deviceGeneration: 4
    };

    const request = createPipelineCompileRequest(input);
    input.pipelineKey = 'pipeline:mutated';
    input.featurePolicyHash = 'policy:mutated';

    expect(request).toEqual({
      pipelineKey: 'pipeline:a',
      requestRevision: 1,
      shaderRevision: 2,
      layoutRevision: 3,
      featurePolicyHash: 'policy:a',
      deviceGeneration: 4
    });
    expect(Object.isFrozen(request)).toBe(true);
  });

  it.each([
    [{ pipelineKey: '', featurePolicyHash: 'policy:a' }, 'pipeline key'],
    [{ pipelineKey: 'pipeline:a', featurePolicyHash: '' }, 'FeaturePolicy hash'],
    [
      { pipelineKey: 'pipeline:a', featurePolicyHash: 'policy:a', requestRevision: -1 },
      'request revision'
    ],
    [
      { pipelineKey: 'pipeline:a', featurePolicyHash: 'policy:a', shaderRevision: 1.5 },
      'shader revision'
    ],
    [
      { pipelineKey: 'pipeline:a', featurePolicyHash: 'policy:a', layoutRevision: Number.NaN },
      'layout revision'
    ],
    [
      { pipelineKey: 'pipeline:a', featurePolicyHash: 'policy:a', deviceGeneration: -1 },
      'device generation'
    ]
  ])('rejects malformed public request facts %#', (override, label) => {
    const input = Object.assign(
      {
        pipelineKey: 'pipeline:a',
        requestRevision: 1,
        shaderRevision: 2,
        layoutRevision: 3,
        featurePolicyHash: 'policy:a',
        deviceGeneration: 4
      },
      override
    );
    expect(() => createPipelineCompileRequest(input)).toThrow(`Pipeline compile ${label} must`);
  });

  it('rejects malformed cache lookup keys at the public boundary', () => {
    const cache = new PipelineCache(UNUSED_COMPILER);

    expect(() => cache.snapshot('   ')).toThrow('Pipeline cache key must be non-empty.');
  });
});

describe('PipelineCache request lifecycle', () => {
  it('coalesces concurrent requests and publishes one ready pipeline', async () => {
    const deferred = deferredOutcome();
    const compiled: string[] = [];
    const cache = new PipelineCache({
      compile: async (request) => {
        compiled.push(request.pipelineKey);
        return deferred.promise;
      }
    });

    const first = cache.request(requestFor());
    const second = cache.request(requestFor());

    expect(first).not.toBe(second);
    expect(first.requestId).toBe(second.requestId);
    expect(cache.snapshot('pipeline:a')).toEqual({ kind: 'queued', requestId: first.requestId });
    expect(compiled).toEqual([]);

    await Promise.resolve();
    expect(cache.snapshot('pipeline:a')).toMatchObject({
      kind: 'compiling',
      requestId: first.requestId
    });
    expect(compiled).toEqual(['pipeline:a']);

    deferred.resolve({ status: 'success', pipeline: PIPELINE });
    await flushCompilation();

    expect(cache.snapshot('pipeline:a')).toEqual({
      kind: 'ready',
      pipeline: PIPELINE,
      deviceGeneration: 4
    });
  });

  it('cancels queued work only after every interest lease is released', async () => {
    let compileCount = 0;
    const cache = new PipelineCache({
      compile: async () => {
        compileCount += 1;
        return { status: 'success', pipeline: PIPELINE };
      }
    });
    const first = cache.request(requestFor());
    const second = cache.request(requestFor());

    first.release();
    first.release();
    expect(first.released).toBe(true);
    expect(cache.snapshot('pipeline:a').kind).toBe('queued');

    second.release();
    expect(cache.snapshot('pipeline:a')).toEqual({ kind: 'absent' });
    await flushCompilation();
    expect(compileCount).toBe(0);
  });

  it('caches structured compile errors and does not retry unchanged input', async () => {
    let compileCount = 0;
    const cache = new PipelineCache({
      compile: async () => {
        compileCount += 1;
        return {
          status: 'error',
          diagnostic: { code: 'shader-invalid', message: 'Shader validation failed.' }
        };
      }
    });

    cache.request(requestFor());
    await flushCompilation();
    expect(cache.snapshot('pipeline:a')).toEqual({
      kind: 'errored',
      diagnostic: { code: 'shader-invalid', message: 'Shader validation failed.' },
      retry: 'input-change'
    });

    cache.request(requestFor());
    await flushCompilation();
    expect(compileCount).toBe(1);
  });

  it('converts thrown compiler values into bounded diagnostics', async () => {
    const cache = new PipelineCache({
      compile: async () => {
        throw new Error('native compiler exploded');
      }
    });

    cache.request(requestFor());
    await flushCompilation();

    expect(cache.snapshot('pipeline:a')).toEqual({
      kind: 'errored',
      diagnostic: { code: 'pipeline-compile-failed', message: 'native compiler exploded' },
      retry: 'input-change'
    });
  });
});

describe('PipelineCache invalidation', () => {
  it('discards and cleans up an old completion after a newer request replaces it', async () => {
    const first = deferredOutcome();
    const second = deferredOutcome();
    const outcomes = [first.promise, second.promise];
    let compileIndex = 0;
    const stalePipeline = disposablePipeline(101);
    const newerPipeline = Object.freeze({ id: 102 }) as unknown as RHIRenderPipeline;
    const cache = new PipelineCache({
      compile: async () => outcomes[compileIndex++] as Promise<PipelineCompileOutcome>
    });

    cache.request(requestFor());
    await Promise.resolve();
    cache.invalidate('pipeline:a', 'device-generation-changed');
    expect(cache.snapshot('pipeline:a')).toEqual({
      kind: 'stale',
      reason: 'device-generation-changed'
    });

    cache.request(requestWith({ requestRevision: 2, deviceGeneration: 5 }));
    await Promise.resolve();
    first.resolve({
      status: 'success',
      pipeline: stalePipeline
    });
    await flushCompilation();

    expect(stalePipeline.dispose).toHaveBeenCalledOnce();
    expect(cache.snapshot('pipeline:a')).toMatchObject({ kind: 'compiling' });

    second.resolve({ status: 'success', pipeline: newerPipeline });
    await flushCompilation();
    expect(cache.snapshot('pipeline:a')).toEqual({
      kind: 'ready',
      pipeline: newerPipeline,
      deviceGeneration: 5
    });
    expect(cache.metrics()).toEqual({
      duplicateRequests: 0,
      compileStarts: 2,
      compileErrors: 0,
      staleResultsDiscarded: 1,
      readyPublications: 1
    });
    expect(Object.isFrozen(cache.metrics())).toBe(true);
  });

  it.each([
    'request-revision-changed',
    'shader-revision-changed',
    'layout-revision-changed',
    'feature-policy-changed',
    'device-generation-changed'
  ] as const)('publishes the explicit %s stale reason', async (reason) => {
    const deferred = deferredOutcome();
    const cache = new PipelineCache({ compile: async () => deferred.promise });
    cache.request(requestFor());
    await Promise.resolve();

    cache.invalidate('pipeline:a', reason);

    expect(cache.snapshot('pipeline:a')).toEqual({ kind: 'stale', reason });
    deferred.resolve({ status: 'error', diagnostic: { code: 'late', message: 'late' } });
    await flushCompilation();
    expect(cache.snapshot('pipeline:a')).toEqual({ kind: 'stale', reason });
    expect(cache.metrics().staleResultsDiscarded).toBe(1);
  });

  it('allows an explicitly invalidated compile error to be requested again', async () => {
    let compileCount = 0;
    const cache = new PipelineCache({
      compile: async () => {
        compileCount += 1;
        return compileCount === 1
          ? { status: 'error', diagnostic: { code: 'invalid', message: 'invalid' } }
          : { status: 'success', pipeline: PIPELINE };
      }
    });
    cache.request(requestFor());
    await flushCompilation();

    cache.invalidate('pipeline:a', 'shader-revision-changed');
    cache.request(requestWith({ requestRevision: 2, shaderRevision: 3 }));
    await flushCompilation();

    expect(compileCount).toBe(2);
    expect(cache.snapshot('pipeline:a').kind).toBe('ready');
  });
});

describe('PipelineCache ready ownership', () => {
  it('retains an invalidated ready pipeline until its pending submission completes', async () => {
    const submission = deferredSubmission(10);
    const pipeline = disposablePipeline(201);
    const cache = new PipelineCache({
      compile: async () => ({ status: 'success', pipeline })
    });
    cache.request(requestFor());
    await flushCompilation();

    const lease = cache.acquireReady('pipeline:a')!;
    expect(lease.pipeline).toBe(pipeline);
    expect(lease.deviceGeneration).toBe(4);
    lease.retain(submission.value);
    cache.invalidate('pipeline:a', 'shader-revision-changed');
    lease.release();

    expect(cache.acquireReady('pipeline:a')).toBeUndefined();
    expect(pipeline.dispose).not.toHaveBeenCalled();
    submission.resolve({ status: 'completed' });
    await submission.value.done;
    await Promise.resolve();
    expect(pipeline.dispose).toHaveBeenCalledOnce();
  });

  it('invalidates only the requested device generation and immediately disposes unleased entries', async () => {
    const oldPipeline = disposablePipeline(202);
    const nextPipeline = disposablePipeline(203);
    const cache = new PipelineCache({
      compile: async (request) => ({
        status: 'success',
        pipeline: request.deviceGeneration === 4 ? oldPipeline : nextPipeline
      })
    });
    cache.request(requestFor('pipeline:old'));
    cache.request(
      createPipelineCompileRequest({
        ...requestFor('pipeline:next'),
        deviceGeneration: 5
      })
    );
    await flushCompilation();

    expect(cache.invalidateDeviceGeneration(4)).toBe(1);
    expect(cache.acquireReady('pipeline:old')).toBeUndefined();
    expect(cache.acquireReady('pipeline:next')?.pipeline).toBe(nextPipeline);
    expect(oldPipeline.dispose).toHaveBeenCalledOnce();
    expect(nextPipeline.dispose).not.toHaveBeenCalled();
    expect(() => cache.request(requestWith({ requestRevision: 2 }))).toThrow(
      /device generation has been invalidated/i
    );
  });

  it('does not compile or wait when a ready lease is unavailable', () => {
    const compile = vi.fn(UNUSED_COMPILER.compile);
    const cache = new PipelineCache({ compile });

    expect(cache.acquireReady('pipeline:absent')).toBeUndefined();
    expect(compile).not.toHaveBeenCalled();
  });

  it('reports contained pipeline disposal failures', async () => {
    const pipeline = disposablePipeline(204);
    pipeline.dispose.mockImplementation(() => {
      throw new Error('pipeline dispose failed');
    });
    const cache = new PipelineCache({
      compile: async () => ({ status: 'success', pipeline })
    });
    cache.request(requestFor());
    await flushCompilation();

    cache.invalidate('pipeline:a', 'shader-revision-changed');

    expect(cache.cleanupErrors()).toHaveLength(1);
  });
});
