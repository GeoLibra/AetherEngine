/** Returns the first cascade containing `viewDepth`, or undefined outside shadow distance. */
export function selectShadowCascade(
  viewDepth: number,
  splitDepths: readonly number[]
): number | undefined {
  if (!Number.isFinite(viewDepth) || viewDepth < 0) {
    throw new Error('Shadow receiver view depth must be finite and non-negative.');
  }
  if (
    splitDepths.length === 0 ||
    splitDepths.some(
      (split, index) =>
        !Number.isFinite(split) || split <= 0 || (index > 0 && split <= splitDepths[index - 1]!)
    )
  ) {
    throw new Error('Shadow cascade splits must be finite, positive, and strictly increasing.');
  }
  const cascade = splitDepths.findIndex((split) => viewDepth <= split);
  return cascade < 0 ? undefined : cascade;
}

/** Computes constant plus slope-scaled receiver bias in normalized shadow depth units. */
export function computeShadowDepthBias(
  normalDotLight: number,
  constantBias: number,
  slopeBias: number
): number {
  if (![normalDotLight, constantBias, slopeBias].every(Number.isFinite)) {
    throw new Error('Shadow bias inputs must be finite.');
  }
  if (constantBias < 0 || slopeBias < 0) {
    throw new Error('Shadow bias terms must be non-negative.');
  }
  return constantBias + slopeBias * (1 - Math.max(0, Math.min(1, normalDotLight)));
}

/** CPU oracle for a less-equal percentage-closer filtered depth comparison. */
export function visibilityFromDepthSamples(
  receiverDepth: number,
  sampledDepths: readonly number[]
): number {
  if (!Number.isFinite(receiverDepth)) throw new Error('Shadow receiver depth must be finite.');
  if (sampledDepths.some((depth) => !Number.isFinite(depth))) {
    throw new Error('Shadow depth samples must be finite.');
  }
  if (sampledDepths.length === 0) return 1;
  let visible = 0;
  for (const depth of sampledDepths) visible += receiverDepth <= depth ? 1 : 0;
  return visible / sampledDepths.length;
}
