import { PreparedAssetRegistry } from '../../src/rendering/world';
import type { PreparedVariantKey } from '../../src/rendering/world';

/** Builds a stable GPU-variant population for indexed and full-scan lookup comparison. */
export function createPreparedAssetLookupFixture(
  totalVariants: number,
  targetVariants: number
): Readonly<{
  subject(): readonly unknown[];
  reference(): readonly unknown[];
  expected: readonly unknown[];
  targetVariants: number;
}> {
  if (
    !Number.isSafeInteger(totalVariants) ||
    totalVariants < 1 ||
    !Number.isSafeInteger(targetVariants) ||
    targetVariants < 0 ||
    targetVariants > totalVariants
  ) {
    throw new Error(
      'Prepared asset lookup fixture requires valid total and target variant counts.'
    );
  }
  const registry = new PreparedAssetRegistry();
  const keys: PreparedVariantKey[] = [];
  for (let index = 0; index < totalVariants; index++) {
    const key = Object.freeze({
      assetId: index < targetVariants ? 'asset:status-target' : `asset:status-other/${index}`,
      payloadVersion: index + 1,
      deviceGeneration: 1,
      featurePolicyKey: 'benchmark-policy',
      abiVersion: 'benchmark-v1'
    });
    keys.push(key);
    registry.publish({ key, value: { byteLength: index + 1 } });
  }
  const reference = Object.freeze(
    keys
      .map((key) => registry.inspect(key))
      .filter((snapshot) => snapshot?.key.assetId === 'asset:status-target')
  );
  return Object.freeze({
    targetVariants,
    subject: () => registry.inspectAsset('asset:status-target'),
    reference: () =>
      Object.freeze(
        keys
          .map((key) => registry.inspect(key))
          .filter((snapshot) => snapshot?.key.assetId === 'asset:status-target')
      ),
    expected: reference
  });
}
