import type {
  CookGarbageCollectionOptions,
  CookGarbageCollectionPlan,
  CookGarbageCollectionSnapshot
} from './types';

/** Plans deletion of expired objects outside every durable or caller-retained closure. */
export function planCookGarbageCollection(
  snapshot: CookGarbageCollectionSnapshot,
  options: CookGarbageCollectionOptions
): CookGarbageCollectionPlan {
  if (!Number.isFinite(options.nowMs)) throw new Error('Cook GC nowMs must be finite.');
  if (!Number.isFinite(options.minimumAgeMs) || options.minimumAgeMs <= 0) {
    throw new Error('Cook GC minimumAgeMs must be greater than zero.');
  }
  const retained = new Set(options.retainedHashes);
  for (const manifest of snapshot.published) addOutputs(retained, manifest.outputs);
  for (const transaction of snapshot.transactions) {
    if (transaction.state !== 'committed' && transaction.state !== 'aborted') {
      addOutputs(retained, transaction.outputs);
    }
  }

  const cutoff = options.nowMs - options.minimumAgeMs;
  const candidates = snapshot.objects
    .filter((object) => object.createdAtMs <= cutoff && !retained.has(object.hash))
    .sort((left, right) => left.hash.localeCompare(right.hash));
  return Object.freeze({
    deleteHashes: Object.freeze(candidates.map(({ hash }) => hash)),
    deleteBytes: candidates.reduce((total, { length }) => total + length, 0),
    retainedObjects: snapshot.objects.length - candidates.length
  });
}

function addOutputs(retained: Set<string>, outputs: readonly { readonly hash: string }[]): void {
  for (const output of outputs) retained.add(output.hash);
}
