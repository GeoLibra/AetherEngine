import { describe, expect, test } from 'vitest';
import { runBindingLayoutScenario } from '../../benchmark/shader-system/binding-layout-scenario';

describe('shader binding-layout benchmark oracle', () => {
  test.each(
    [1, 4, 8].flatMap((groups) =>
      [4, 16, 64].map((bindingsPerGroup) => [groups, bindingsPerGroup] as const)
    )
  )('validates %i groups with %i bindings per group', (groups, bindingsPerGroup) => {
    const result = runBindingLayoutScenario({ groups, bindingsPerGroup, cacheHits: 3 });

    expect(result).toMatchObject({
      reorderEquivalent: true,
      cacheHits: 3,
      cacheMisses: 1,
      unsupportedCount: 1,
      synchronousRhiCreates: 0
    });
    expect(result.bindingCount).toBe(groups * bindingsPerGroup);
    expect(result.checksum).not.toBe(0);
  });
});
