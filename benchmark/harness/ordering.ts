export function deterministicOrder<T>(values: readonly T[], seed: number): readonly T[] {
  const result = [...values];
  let state = seed >>> 0 || 0x9e3779b9;

  for (let index = result.length - 1; index > 0; index--) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const target = (state >>> 0) % (index + 1);
    [result[index], result[target]] = [result[target]!, result[index]!];
  }

  return Object.freeze(result);
}
