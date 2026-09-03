import { describe, expect, test } from 'vitest';
import { planCookGarbageCollection } from '../../src/assets/cook';

describe('planCookGarbageCollection', () => {
  test('collects only old objects outside published, in-flight, and leased closures', () => {
    const plan = planCookGarbageCollection(
      {
        objects: [
          { hash: 'published', length: 10, createdAtMs: 0 },
          { hash: 'in-flight', length: 20, createdAtMs: 0 },
          { hash: 'leased', length: 30, createdAtMs: 0 },
          { hash: 'committed-old', length: 40, createdAtMs: 0 },
          { hash: 'orphan-old', length: 50, createdAtMs: 0 },
          { hash: 'orphan-recent', length: 60, createdAtMs: 950 }
        ],
        published: [manifest('published-node', 'published')],
        transactions: [
          transaction('active', 'validating', 'in-flight'),
          transaction('complete', 'committed', 'committed-old')
        ]
      },
      { nowMs: 1_000, minimumAgeMs: 100, retainedHashes: ['leased'] }
    );

    expect(plan.deleteHashes).toEqual(['committed-old', 'orphan-old']);
    expect(plan.deleteBytes).toBe(90);
    expect(plan.retainedObjects).toBe(4);
  });

  test('rejects a retention window that could race newly written objects', () => {
    expect(() =>
      planCookGarbageCollection(
        { objects: [], published: [], transactions: [] },
        { nowMs: 1_000, minimumAgeMs: 0, retainedHashes: [] }
      )
    ).toThrow('minimumAgeMs must be greater than zero');
  });
});

function manifest(nodeId: string, hash: string) {
  return {
    nodeId,
    artifactKey: `artifact-${nodeId}`,
    inputHashes: [],
    toolchainVersion: 'test',
    outputs: [{ name: 'output', hash, length: 1 }]
  };
}

function transaction(transactionId: string, state: 'validating' | 'committed', hash: string) {
  return {
    ...manifest(`node-${transactionId}`, hash),
    transactionId,
    state
  };
}
