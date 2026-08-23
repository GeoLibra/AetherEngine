import { describe, expect, it } from 'vitest';
import { PipelineCache, createPipelineCompileRequest, type PipelineCompiler } from '../../src';

const UNUSED_COMPILER: PipelineCompiler = Object.freeze({
  compile: async () => {
    throw new Error('Compiler must not run during snapshot lookup.');
  }
});

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
