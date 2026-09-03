import { planCookGarbageCollection } from '../../src/assets/cook';
import type { CookGarbageCollectionSnapshot } from '../../src/assets/cook';

/** Builds a deterministic half-live object population for GC scaling evidence. */
export function createCookGarbageCollectionFixture(
  objectCount: number
): CookGarbageCollectionSnapshot {
  const objects = Array.from({ length: objectCount }, (_, index) => ({
    hash: `hash-${index.toString().padStart(8, '0')}`,
    length: 64,
    createdAtMs: 0
  }));
  return Object.freeze({
    objects: Object.freeze(objects),
    published: Object.freeze(
      objects
        .filter((_object, index) => index % 2 === 0)
        .map((object, index) => ({
          nodeId: `asset://gc/${index}`,
          artifactKey: `artifact-${index}`,
          inputHashes: Object.freeze([]),
          toolchainVersion: 'benchmark',
          outputs: Object.freeze([{ name: 'payload', hash: object.hash, length: object.length }])
        }))
    ),
    transactions: Object.freeze([])
  });
}

/** Runs the production planner with a fixed retention boundary. */
export function planCookGarbageCollectionFixture(snapshot: CookGarbageCollectionSnapshot) {
  return planCookGarbageCollection(snapshot, {
    nowMs: 10_000,
    minimumAgeMs: 1_000,
    retainedHashes: []
  });
}
