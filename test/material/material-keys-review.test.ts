import { describe, expect, test } from 'vitest';
import {
  SubmissionRetainedCache,
  createBindingKey,
  createPipelineKey,
  type BindingKeyParts,
  type CanonicalKey,
  type PipelineKeyParts,
  type RHISubmission,
  type SubmissionResult
} from '../../src';

const pipelineParts: PipelineKeyParts = {
  shaderModuleKey: 'shader',
  entryPoints: [
    { stage: 'vertex', name: 'vs' },
    { stage: 'fragment', name: 'fs' }
  ],
  bindingLayoutHash: 'layout',
  vertexLayoutHash: 'vertex',
  primitiveStateHash: 'primitive',
  depthStencilStateHash: 'depth',
  blendStateHash: 'blend',
  attachmentFormats: ['rgba16float'],
  depthStencilFormat: 'depth24plus',
  sampleCount: 1,
  featurePolicyHash: 'desktop',
  deviceGeneration: 3
};

const bindingParts: BindingKeyParts = {
  bindingLayoutHash: 'layout',
  resources: [
    {
      group: 0,
      binding: 1,
      assetId: 'albedo',
      assetPayloadVersion: 2,
      resourceGeneration: 5
    }
  ],
  bufferAllocationGeneration: 8,
  ringGeneration: 9,
  dynamicOffsets: [256, 512],
  deviceGeneration: 3
};

describe('Canonical key ownership and validation', () => {
  test('changes the pipeline identity when an entry point changes', () => {
    const original = createPipelineKey(pipelineParts);
    const changed = createPipelineKey({
      ...pipelineParts,
      entryPoints: [
        { stage: 'vertex', name: 'vs-v2' },
        { stage: 'fragment', name: 'fs' }
      ]
    });

    expect(changed.canonicalValue).not.toBe(original.canonicalValue);
    expect(changed.hash).not.toBe(original.hash);
  });

  test('makes CanonicalKey factory-owned at compile time and runtime', () => {
    const real = createBindingKey(bindingParts);
    const structural = { canonicalValue: real.canonicalValue, hash: real.hash, parts: real.parts };
    // @ts-expect-error Canonical keys cannot be structurally fabricated.
    const compileTimeForgery: CanonicalKey<BindingKeyParts> = structural;
    const cache = new SubmissionRetainedCache<string>();

    expect(() =>
      cache.publish(structural as unknown as CanonicalKey<BindingKeyParts>, 'forged')
    ).toThrow(/factory-owned canonical key/i);
    cache.publish(real, 'real');
    expect(cache.acquire(structural as unknown as CanonicalKey<BindingKeyParts>)).toBeUndefined();
    expect(cache.metrics()).toMatchObject({ staleHitRejected: 1, staleReuse: 0 });
    expect(compileTimeForgery.canonicalValue).toBe(real.canonicalValue);
  });

  test('rejects an internally inconsistent clone without returning an old value', () => {
    const real = createBindingKey(bindingParts);
    const inconsistent = Object.freeze({
      ...real,
      parts: Object.freeze({ ...real.parts, deviceGeneration: 99 })
    }) as CanonicalKey<BindingKeyParts>;
    const cache = new SubmissionRetainedCache<string>();
    cache.publish(real, 'old');

    expect(cache.acquire(inconsistent)).toBeUndefined();
    expect(() => cache.publish(inconsistent, 'forged')).toThrow(/factory-owned canonical key/i);
    expect(cache.metrics()).toMatchObject({ staleHitRejected: 1, staleReuse: 0 });
  });

  test.each([
    ['empty shader module', { shaderModuleKey: '' }],
    ['empty entry point', { entryPoints: [{ stage: 'vertex', name: '' }] }],
    ['empty binding layout', { bindingLayoutHash: '' }],
    ['empty vertex layout', { vertexLayoutHash: '' }],
    ['empty primitive state', { primitiveStateHash: '' }],
    ['empty depth state', { depthStencilStateHash: '' }],
    ['empty blend state', { blendStateHash: '' }],
    ['empty attachment format', { attachmentFormats: [''] }],
    ['empty depth format', { depthStencilFormat: '' }],
    ['empty feature policy', { featurePolicyHash: '' }],
    ['zero sample count', { sampleCount: 0 }],
    ['fractional sample count', { sampleCount: 1.5 }],
    ['NaN sample count', { sampleCount: Number.NaN }],
    ['infinite sample count', { sampleCount: Number.POSITIVE_INFINITY }],
    ['negative device generation', { deviceGeneration: -1 }],
    ['fractional device generation', { deviceGeneration: 1.5 }],
    ['NaN device generation', { deviceGeneration: Number.NaN }]
  ])('rejects invalid pipeline identity: %s', (_label, changed) => {
    expect(() => createPipelineKey({ ...pipelineParts, ...changed } as PipelineKeyParts)).toThrow(
      /invalid pipeline key/i
    );
  });

  test.each([
    ['empty layout', { bindingLayoutHash: '' }],
    ['negative group', resource({ group: -1 })],
    ['fractional binding', resource({ binding: 1.5 })],
    ['NaN group', resource({ group: Number.NaN })],
    ['infinite binding', resource({ binding: Number.POSITIVE_INFINITY })],
    ['empty asset id', resource({ assetId: '' })],
    ['negative payload generation', resource({ assetPayloadVersion: -1 })],
    ['fractional resource generation', resource({ resourceGeneration: 1.5 })],
    ['negative allocation generation', { bufferAllocationGeneration: -1 }],
    ['NaN ring generation', { ringGeneration: Number.NaN }],
    ['fractional device generation', { deviceGeneration: 2.5 }],
    ['negative dynamic offset', { dynamicOffsets: [-1] }],
    ['infinite dynamic offset', { dynamicOffsets: [Number.POSITIVE_INFINITY] }]
  ])('rejects invalid binding identity: %s', (_label, changed) => {
    expect(() => createBindingKey({ ...bindingParts, ...changed } as BindingKeyParts)).toThrow(
      /invalid binding key/i
    );
  });
});

describe('Complete binding cache identity and submission lifetime', () => {
  test.each([
    ['layout', { bindingLayoutHash: 'layout-v2' }],
    ['payload', resource({ assetPayloadVersion: 3 })],
    ['resource generation', resource({ resourceGeneration: 6 })],
    ['allocation generation', { bufferAllocationGeneration: 9 }],
    ['ring generation', { ringGeneration: 10 }],
    ['dynamic offsets', { dynamicOffsets: [512, 256] }],
    ['device generation', { deviceGeneration: 4 }]
  ])('misses and rebuilds without returning old value when %s changes', (_label, changed) => {
    const oldKey = createBindingKey(bindingParts);
    const changedKey = createBindingKey({ ...bindingParts, ...changed } as BindingKeyParts);
    const cache = new SubmissionRetainedCache<string>();
    cache.publish(oldKey, 'old');

    expect(cache.acquire(changedKey)).toBeUndefined();
    cache.publish(changedKey, 'rebuilt');
    const rebuilt = cache.acquire(changedKey);
    expect(rebuilt?.value).toBe('rebuilt');
    expect(rebuilt?.value).not.toBe('old');
    rebuilt?.release();
    expect(cache.metrics().staleReuse).toBe(0);
  });

  test('retains distinct submission objects even when their ids are equal', async () => {
    const destroyed: string[] = [];
    const cache = new SubmissionRetainedCache<string>({
      destroy: (value) => destroyed.push(value)
    });
    const key = createBindingKey(bindingParts);
    const first = deferredSubmission(7);
    const second = deferredSubmission(7);
    cache.publish(key, 'binding');
    const lease = cache.acquire(key)!;
    lease.retain(first.value);
    lease.retain(second.value);
    cache.retire(key);
    lease.release();

    expect(cache.metrics().fencePending).toBe(2);
    first.resolve({ status: 'completed' });
    await first.value.done;
    await Promise.resolve();
    expect(destroyed).toEqual([]);
    second.resolve({ status: 'completed' });
    await second.value.done;
    await Promise.resolve();
    expect(destroyed).toEqual(['binding']);
  });

  test('allows republishing the same canonical key after physical destruction', () => {
    const cache = new SubmissionRetainedCache<string>();
    const key = createBindingKey(bindingParts);
    cache.publish(key, 'first');
    cache.retire(key);

    expect(() => cache.publish(key, 'second')).not.toThrow();
    expect(cache.acquire(key)?.value).toBe('second');
    expect(cache.metrics()).toMatchObject({ published: 2, destroyed: 1, staleReuse: 0 });
  });
});

function resource(changed: Partial<BindingKeyParts['resources'][number]>) {
  return { resources: [{ ...bindingParts.resources[0]!, ...changed }] };
}

function deferredSubmission(id: number) {
  let status: RHISubmission['status'] = 'pending';
  let resolvePromise!: (result: SubmissionResult) => void;
  const done = new Promise<SubmissionResult>((resolve) => {
    resolvePromise = resolve;
  });
  const value: RHISubmission = {
    id,
    get status() {
      return status;
    },
    done
  };
  return {
    value,
    resolve(result: SubmissionResult) {
      status = result.status;
      resolvePromise(result);
    }
  };
}
