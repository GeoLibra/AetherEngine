import { expect, test } from 'vitest';
import { NullDevice } from '../../src/rhi';
import { CookedTextureRegistry } from '../../src/assets/cooker/cooked-texture-registry';

test('counts physical builtin allocations once and clears their residency on disposal', () => {
  const registry = new CookedTextureRegistry();
  const device = new NullDevice();
  expect(registry.inspectResidency()).toEqual({ textureBytes: 0, textureCount: 0 });
  registry.prepare(device);
  expect(registry.inspectResidency()).toEqual({ textureBytes: 16, textureCount: 4 });
  registry.prepare(device);
  expect(registry.inspectResidency()).toEqual({ textureBytes: 16, textureCount: 4 });
  registry.dispose();
  expect(registry.inspectResidency()).toEqual({ textureBytes: 0, textureCount: 0 });
});
