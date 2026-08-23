import { describe, expect, it } from 'vitest';
import {
  PipelineCache,
  createPipelineCompileRequest,
  type PipelineCompileOutcome,
  type PipelineCompiler
} from '../../src';
import type { RHIRenderPipeline } from '../../src/rhi/contracts';

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
    let staleDisposals = 0;
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
      pipeline: PIPELINE,
      disposeUnpublished: () => {
        staleDisposals += 1;
      }
    });
    await flushCompilation();

    expect(staleDisposals).toBe(1);
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
