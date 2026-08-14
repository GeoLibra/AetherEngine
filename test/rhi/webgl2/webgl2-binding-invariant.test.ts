import { describe, expect, test } from 'vitest';

import { requireDynamicBufferResource } from '../../../src/rhi/webgl2/bindings';

describe('WebGL2 binding invariants', () => {
  test('rejects a missing validated dynamic buffer resource', () => {
    expect(() => requireDynamicBufferResource(undefined, 3)).toThrow(
      'WebGL2 bind group invariant failed: dynamic binding 3 has no resource.'
    );
  });

  test('rejects a validated dynamic binding with the wrong resource kind', () => {
    const textureResource = { kind: 'texture-view' } as never;
    expect(() => requireDynamicBufferResource(textureResource, 3)).toThrow(
      'WebGL2 bind group invariant failed: dynamic binding 3 is not a buffer.'
    );
  });
});
