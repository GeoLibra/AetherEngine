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
  shaderModuleKey: 'shader|with:separators',
  entryPoints: [
    { stage: 'vertex', name: 'main|vs' },
    { stage: 'fragment', name: 'main:fs' }
  ],
  bindingLayoutHash: 'layout',
  vertexLayoutHash: 'vertex',
  primitiveStateHash: 'primitive',
  depthStencilStateHash: 'depth',
  blendStateHash: 'blend',
  attachmentFormats: ['rgba16float', 'r32uint'],
  depthStencilFormat: 'depth24plus',
  sampleCount: 1,
  featurePolicyHash: 'desktop',
  deviceGeneration: 3
};

const bindingParts: BindingKeyParts = {
  bindingLayoutHash: 'layout',
  resources: [
    {
      group: 1,
      binding: 2,
      assetId: 'normal|texture',
      assetPayloadVersion: 4,
      resourceGeneration: 7
    },
    {
      group: 0,
      binding: 1,
      assetId: 'albedo:texture',
      assetPayloadVersion: 2,
      resourceGeneration: 5
    }
  ],
  bufferAllocationGeneration: 8,
  ringGeneration: 9,
  dynamicOffsets: [256, 512],
  deviceGeneration: 3
};

describe('Canonical material keys', () => {
  test.each([
    ['shaderModuleKey', 'shader-v2'],
    ['bindingLayoutHash', 'layout-v2'],
    ['vertexLayoutHash', 'vertex-v2'],
    ['primitiveStateHash', 'primitive-v2'],
    ['depthStencilStateHash', 'depth-v2'],
    ['blendStateHash', 'blend-v2'],
    ['attachmentFormats', ['rgba8unorm']],
    ['depthStencilFormat', 'depth32float'],
    ['sampleCount', 4],
    ['featurePolicyHash', 'mobile'],
    ['deviceGeneration', 4]
  ] as const)('changes the pipeline key when %s changes', (axis, value) => {
    const original = createPipelineKey(pipelineParts);
    const changed = createPipelineKey({ ...pipelineParts, [axis]: value });

    expect(changed.canonicalValue).not.toBe(original.canonicalValue);
    expect(changed.hash).not.toBe(original.hash);
  });

  test('canonicalizes entry stages but preserves attachment order and rejects duplicate stages', () => {
    const reversedStages = createPipelineKey({
      ...pipelineParts,
      entryPoints: [...pipelineParts.entryPoints].reverse()
    });
    const reversedAttachments = createPipelineKey({
      ...pipelineParts,
      attachmentFormats: [...pipelineParts.attachmentFormats].reverse()
    });

    expect(reversedStages.canonicalValue).toBe(createPipelineKey(pipelineParts).canonicalValue);
    expect(reversedAttachments.canonicalValue).not.toBe(
      createPipelineKey(pipelineParts).canonicalValue
    );
    expect(() =>
      createPipelineKey({
        ...pipelineParts,
        entryPoints: [
          { stage: 'vertex', name: 'one' },
          { stage: 'vertex', name: 'two' }
        ]
      })
    ).toThrow(/duplicate.*vertex/i);
  });

  test('uses length-safe encoding for separator-containing values', () => {
    const left = createPipelineKey({
      ...pipelineParts,
      shaderModuleKey: 'a|b',
      vertexLayoutHash: 'c'
    });
    const right = createPipelineKey({
      ...pipelineParts,
      shaderModuleKey: 'a',
      vertexLayoutHash: 'b|c'
    });

    expect(left.canonicalValue).not.toBe(right.canonicalValue);
  });

  test.each([
    ['bindingLayoutHash', 'layout-v2'],
    ['bufferAllocationGeneration', 10],
    ['ringGeneration', 10],
    ['dynamicOffsets', [512, 256]],
    ['deviceGeneration', 4]
  ] as const)('changes the binding key when %s changes', (axis, value) => {
    expect(createBindingKey({ ...bindingParts, [axis]: value }).canonicalValue).not.toBe(
      createBindingKey(bindingParts).canonicalValue
    );
  });

  test('sorts resources but preserves dynamic-offset order', () => {
    const reorderedResources = createBindingKey({
      ...bindingParts,
      resources: [...bindingParts.resources].reverse()
    });
    const reorderedOffsets = createBindingKey({
      ...bindingParts,
      dynamicOffsets: [...bindingParts.dynamicOffsets].reverse()
    });

    expect(reorderedResources.canonicalValue).toBe(createBindingKey(bindingParts).canonicalValue);
    expect(reorderedOffsets.canonicalValue).not.toBe(createBindingKey(bindingParts).canonicalValue);
  });

  test.each([
    ['asset payload version', { assetPayloadVersion: 5 }],
    ['resource generation', { resourceGeneration: 8 }]
  ])('changes the binding key for a %s switch', (_label, changed) => {
    const resources = bindingParts.resources.map((resource, index) =>
      index === 0 ? { ...resource, ...changed } : resource
    );
    expect(createBindingKey({ ...bindingParts, resources }).canonicalValue).not.toBe(
      createBindingKey(bindingParts).canonicalValue
    );
  });

  test('excludes parameter values and revisions from the binding key surface', () => {
    // @ts-expect-error Parameter revisions are upload facts, not binding identity.
    const invalid: BindingKeyParts = { ...bindingParts, parameterRevision: 12 };
    expect(invalid).toBeDefined();
  });
});

describe('Submission-retained material caches', () => {
  test('publishes, acquires, rejects duplicates and records hit/miss counters', () => {
    const cache = new SubmissionRetainedCache<string>();
    const key = createBindingKey(bindingParts);

    cache.publish(key, 'binding-v1');
    const lease = cache.acquire(key);

    expect(lease?.value).toBe('binding-v1');
    expect(() => cache.publish(key, 'duplicate')).toThrow(/already published/i);
    expect(
      cache.acquire(createBindingKey({ ...bindingParts, ringGeneration: 10 }))
    ).toBeUndefined();
    expect(cache.metrics()).toMatchObject({ hits: 1, misses: 1, published: 1, staleReuse: 0 });
    lease?.release();
  });

  test('keeps colliding canonical values in one hash bucket', () => {
    const hasher = () => 'collision';
    const first = createBindingKey(bindingParts, hasher);
    const second = createBindingKey({ ...bindingParts, ringGeneration: 10 }, hasher);
    const cache = new SubmissionRetainedCache<string>();

    cache.publish(first, 'first');
    cache.publish(second, 'second');
    const firstLease = cache.acquire(first);
    const secondLease = cache.acquire(second);

    expect(firstLease?.value).toBe('first');
    expect(secondLease?.value).toBe('second');
    firstLease?.release();
    secondLease?.release();
  });

  test('rejects independently detected stale generations before a value escapes', () => {
    const key = createBindingKey(bindingParts);
    const cache = new SubmissionRetainedCache<string>();
    cache.publish(key, 'old');
    const forged = Object.freeze({
      ...key,
      parts: Object.freeze({ ...key.parts, deviceGeneration: 99 })
    }) as CanonicalKey<BindingKeyParts>;

    expect(cache.acquire(forged)).toBeUndefined();
    expect(cache.metrics()).toMatchObject({
      misses: 1,
      staleHitRejected: 1,
      staleReuse: 0
    });
  });

  test('blocks retired fence-pending republish and destroys after lease and submission terminal', async () => {
    const destroyed: string[] = [];
    const cache = new SubmissionRetainedCache<string>({
      destroy: (value) => destroyed.push(value)
    });
    const key = createBindingKey(bindingParts);
    const submission = deferredSubmission(1);
    cache.publish(key, 'binding');
    const lease = cache.acquire(key)!;
    lease.retain(submission.value);
    lease.retain(submission.value);
    cache.retire(key);
    lease.release();

    expect(() => cache.publish(key, 'too-early')).toThrow(/retired/i);
    expect(destroyed).toEqual([]);
    expect(cache.metrics()).toMatchObject({ retired: 1, fencePending: 1, destroyed: 0 });

    submission.resolve({ status: 'completed' });
    await submission.value.done;
    await Promise.resolve();
    expect(destroyed).toEqual(['binding']);
    expect(cache.metrics()).toMatchObject({ fencePending: 0, destroyed: 1, staleReuse: 0 });
  });

  test.each(['failed', 'device-lost'] as const)(
    'treats %s submissions as terminal and permits release-after-terminal cleanup',
    async (status) => {
      const destroyed: string[] = [];
      const cache = new SubmissionRetainedCache<string>({
        destroy: (value) => destroyed.push(value)
      });
      const key = createBindingKey({
        ...bindingParts,
        ringGeneration: status === 'failed' ? 20 : 21
      });
      const submission = deferredSubmission(status === 'failed' ? 2 : 3);
      cache.publish(key, status);
      const lease = cache.acquire(key)!;
      lease.retain(submission.value);
      submission.resolve({ status });
      await submission.value.done;
      await Promise.resolve();
      cache.retire(key);
      expect(destroyed).toEqual([]);
      lease.release();
      expect(destroyed).toEqual([status]);
    }
  );

  test('treats a rejected done promise as terminal', async () => {
    const destroyed: string[] = [];
    const cache = new SubmissionRetainedCache<string>({
      destroy: (value) => destroyed.push(value)
    });
    const key = createBindingKey({ ...bindingParts, ringGeneration: 30 });
    const submission = deferredSubmission(4);
    cache.publish(key, 'rejected');
    const lease = cache.acquire(key)!;
    lease.retain(submission.value);
    cache.retire(key);
    lease.release();
    submission.reject(new Error('terminal backend rejection'));
    await submission.value.done.catch(() => undefined);
    await Promise.resolve();

    expect(destroyed).toEqual(['rejected']);
    expect(cache.metrics().fencePending).toBe(0);
  });

  test('invalidates one device generation without returning old values', () => {
    const destroyed: string[] = [];
    const cache = new SubmissionRetainedCache<string>({
      destroy: (value) => destroyed.push(value)
    });
    const oldKey = createBindingKey(bindingParts);
    const newKey = createBindingKey({ ...bindingParts, deviceGeneration: 4 });
    cache.publish(oldKey, 'old-device');
    cache.publish(newKey, 'new-device');

    cache.invalidateDevice(3);

    expect(cache.acquire(oldKey)).toBeUndefined();
    expect(cache.acquire(newKey)?.value).toBe('new-device');
    expect(destroyed).toEqual(['old-device']);
  });

  test('contains destroy callback errors and reentrant publication', () => {
    let cache: SubmissionRetainedCache<string>;
    const replacement = createBindingKey({ ...bindingParts, ringGeneration: 41 });
    cache = new SubmissionRetainedCache<string>({
      destroy() {
        cache.publish(replacement, 'replacement');
        throw new Error('destroy failed');
      }
    });
    const original = createBindingKey({ ...bindingParts, ringGeneration: 40 });
    cache.publish(original, 'original');

    expect(() => cache.retire(original)).not.toThrow();
    expect(cache.acquire(replacement)?.value).toBe('replacement');
    expect(cache.destroyErrors()).toHaveLength(1);
    expect(cache.metrics()).toMatchObject({ destroyed: 1, published: 2, staleReuse: 0 });
  });
});

function deferredSubmission(id: number) {
  let status: RHISubmission['status'] = 'pending';
  let resolvePromise!: (result: SubmissionResult) => void;
  let rejectPromise!: (error: unknown) => void;
  const done = new Promise<SubmissionResult>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
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
    },
    reject(error: unknown) {
      status = 'failed';
      rejectPromise(error);
    }
  };
}
