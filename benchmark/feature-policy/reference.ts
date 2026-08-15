import type { FeaturePolicyObservation } from './types';

export function runFeaturePolicyReference(
  featureCount: number,
  candidateCount: number
): FeaturePolicyObservation {
  const selected = Object.freeze(
    Array.from(
      { length: featureCount },
      (_, index) => `bench.feature.${index.toString().padStart(4, '0')}:fallback@1`
    )
  );
  const evaluations = Object.freeze(
    Array.from({ length: featureCount }, (_, index) => {
      const feature = `bench.feature.${index.toString().padStart(4, '0')}`;
      return [
        `${feature}:native@1:rejected-capability`,
        `${feature}:fallback@1:eligible`,
        ...Array.from(
          { length: candidateCount - 2 },
          (_unused, candidateIndex) =>
            `${feature}:wrong-${candidateIndex.toString().padStart(3, '0')}@1:rejected-semantic`
        )
      ];
    }).flat()
  );
  return Object.freeze({
    checksum: checksum([...selected, '--evaluations--', ...evaluations]),
    selected,
    evaluations,
    counters: Object.freeze({
      candidateScans: featureCount * candidateCount,
      selectedFeatures: featureCount,
      hotReadResolveCount: featureCount * 100
    })
  });
}

export function checksum(values: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(JSON.stringify(values))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
