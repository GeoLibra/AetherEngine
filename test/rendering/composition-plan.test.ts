import { describe, expect, it } from 'vitest';
import {
  CompositionPlanCache,
  CompositionPlanError,
  compileCompositionPlan,
  type CompositionPlanInput
} from '../../src';

function input(overrides: Partial<CompositionPlanInput> = {}): CompositionPlanInput {
  return {
    id: 'frame',
    revision: 1,
    policyHash: 'policy-a',
    surfaces: [{ id: 'main', generation: 1, width: 640, height: 480, format: 'rgba8unorm' }],
    slots: [
      {
        id: 'base',
        viewId: 'camera',
        targetId: 'main',
        viewportPixels: { x: 0, y: 0, width: 640, height: 480 },
        colorLoad: 'clear',
        depthLoad: 'clear',
        stores: { color: true, depth: true },
        order: 0,
        present: true
      }
    ],
    ...overrides
  };
}

describe('CompositionPlan', () => {
  it('publishes stable target/order/id ordering and one present owner', () => {
    const plan = compileCompositionPlan(
      input({
        slots: [
          { ...input().slots[0]!, id: 'overlay', colorLoad: 'load', order: 1, present: true },
          { ...input().slots[0]!, id: 'base', order: 0, present: false }
        ]
      })
    );
    expect(plan.slots.map(({ id }) => id)).toEqual(['base', 'overlay']);
    expect(plan.presentOwners.get('main')).toBe('overlay');
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it.each([
    ['load-without-content', [{ ...input().slots[0]!, colorLoad: 'load' }]],
    ['surface-present-owner-missing', [{ ...input().slots[0]!, present: false }]],
    [
      'surface-present-owner-duplicate',
      [input().slots[0]!, { ...input().slots[0]!, id: 'second', order: 1 }]
    ]
  ] as const)('rejects %s', (code, slots) => {
    expect(() => compileCompositionPlan(input({ slots }))).toThrowError(
      expect.objectContaining({ code })
    );
  });

  it('rejects loading depth before a previous slot stores it', () => {
    expect(() =>
      compileCompositionPlan(input({ slots: [{ ...input().slots[0]!, depthLoad: 'load' }] }))
    ).toThrowError(expect.objectContaining({ code: 'load-without-content' }));
  });

  it('requires the present owner to store its color output', () => {
    expect(() =>
      compileCompositionPlan(
        input({ slots: [{ ...input().slots[0]!, stores: { color: false, depth: true } }] })
      )
    ).toThrowError(expect.objectContaining({ code: 'store-required' }));
  });

  it('skips suspended and zero-extent surfaces without assigning present ownership', () => {
    const plan = compileCompositionPlan(
      input({
        surfaces: [
          { id: 'main', generation: 2, width: 0, height: 0, format: 'rgba8unorm', suspended: true }
        ],
        slots: []
      })
    );
    expect(plan.presentOwners.size).toBe(0);
  });

  it('invalidates cache on surface generation and composition policy identity', () => {
    const cache = new CompositionPlanCache();
    const first = cache.compile(input());
    expect(cache.compile(input({ revision: 2 })).status).toBe('hit');
    expect(
      cache.compile(input({ surfaces: [{ ...input().surfaces[0]!, generation: 2 }] })).status
    ).toBe('compiled');
    cache.invalidate([
      { domain: 'composition-plan', previousHash: 'policy-a', nextHash: 'policy-b' }
    ]);
    expect(cache.current).toBeUndefined();
    expect(first.plan.hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('returns typed viewport diagnostics', () => {
    try {
      compileCompositionPlan(
        input({
          slots: [{ ...input().slots[0]!, viewportPixels: { x: 0, y: 0, width: 641, height: 480 } }]
        })
      );
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(CompositionPlanError);
      expect(error).toMatchObject({
        code: 'viewport-out-of-bounds',
        slotId: 'base',
        surfaceId: 'main'
      });
    }
  });

  it('rejects duplicate slot identities', () => {
    expect(() =>
      compileCompositionPlan(
        input({ slots: [input().slots[0]!, { ...input().slots[0]!, order: 1 }] })
      )
    ).toThrowError(expect.objectContaining({ code: 'duplicate-slot-id' }));
  });

  it('rejects duplicate surface identities', () => {
    expect(() =>
      compileCompositionPlan(
        input({ surfaces: [input().surfaces[0]!, { ...input().surfaces[0]! }] })
      )
    ).toThrow('Duplicate or empty composition surface');
  });

  it('rejects non-adjacent overlapping slots with the same order', () => {
    const base = input().slots[0]!;
    expect(() =>
      compileCompositionPlan(
        input({
          slots: [
            {
              ...base,
              id: 'a',
              viewportPixels: { x: 0, y: 0, width: 100, height: 100 },
              present: false
            },
            {
              ...base,
              id: 'b',
              viewportPixels: { x: 200, y: 200, width: 100, height: 100 },
              colorLoad: 'clear',
              present: false
            },
            {
              ...base,
              id: 'c',
              viewportPixels: { x: 50, y: 50, width: 100, height: 100 },
              colorLoad: 'clear'
            }
          ]
        })
      )
    ).toThrowError(expect.objectContaining({ code: 'ambiguous-slot-order', slotId: 'c' }));
  });

  it('preserves stored depth across a slot that has no depth attachment', () => {
    const base = input().slots[0]!;
    expect(() =>
      compileCompositionPlan(
        input({
          slots: [
            { ...base, id: 'base', present: false },
            {
              ...base,
              id: 'hud',
              order: 1,
              colorLoad: 'load',
              depthLoad: 'none',
              stores: { color: true, depth: false },
              present: false
            },
            { ...base, id: 'gizmo', order: 2, colorLoad: 'load', depthLoad: 'load' }
          ]
        })
      )
    ).not.toThrow();
  });

  it('rejects a present owner before the final target slot', () => {
    const base = input().slots[0]!;
    expect(() =>
      compileCompositionPlan(
        input({
          slots: [
            { ...base, present: true },
            { ...base, id: 'overlay', order: 1, colorLoad: 'load', present: false }
          ]
        })
      )
    ).toThrowError(expect.objectContaining({ code: 'store-required', slotId: 'base' }));
  });
});
