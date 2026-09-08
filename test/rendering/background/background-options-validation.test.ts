import { describe, expect, it } from 'vitest';
import {
  NullDevice,
  NullSurface,
  createBaselineRenderingPlugin,
  type BrowserGraphicsSession
} from '../../../src';

describe('baseline background options validation', () => {
  const { graphics } = fixture();

  it('rejects solid background with invalid colorLinear length', () => {
    expect(() =>
      createBaselineRenderingPlugin({
        graphics,
        background: {
          kind: 'solid',
          colorLinear: [1, 0] as any
        }
      })
    ).toThrow(TypeError);
  });

  it('rejects solid background with negative or non-finite colorLinear components', () => {
    expect(() =>
      createBaselineRenderingPlugin({
        graphics,
        background: {
          kind: 'solid',
          colorLinear: [-0.1, 0.5, 0.5]
        }
      })
    ).toThrow(TypeError);

    expect(() =>
      createBaselineRenderingPlugin({
        graphics,
        background: {
          kind: 'solid',
          colorLinear: [Number.NaN, 0.5, 0.5]
        }
      })
    ).toThrow(TypeError);

    expect(() =>
      createBaselineRenderingPlugin({
        graphics,
        background: {
          kind: 'solid',
          colorLinear: [Infinity, 0.5, 0.5]
        }
      })
    ).toThrow(TypeError);
  });

  it('rejects environment background with negative or non-finite multiplier', () => {
    expect(() =>
      createBaselineRenderingPlugin({
        graphics,
        background: {
          kind: 'environment',
          source: 'view-environment',
          representation: 'panorama',
          multiplier: -1
        }
      })
    ).toThrow(TypeError);

    expect(() =>
      createBaselineRenderingPlugin({
        graphics,
        background: {
          kind: 'environment',
          source: 'view-environment',
          representation: 'panorama',
          multiplier: Number.NaN
        }
      })
    ).toThrow(TypeError);
  });

  it('rejects environment background with invalid source or representation', () => {
    expect(() =>
      createBaselineRenderingPlugin({
        graphics,
        background: {
          kind: 'environment',
          source: 'invalid' as any,
          representation: 'panorama',
          multiplier: 1
        }
      })
    ).toThrow(TypeError);

    expect(() =>
      createBaselineRenderingPlugin({
        graphics,
        background: {
          kind: 'environment',
          source: 'view-environment',
          representation: 'cube' as any,
          multiplier: 1
        }
      })
    ).toThrow(TypeError);
  });

  it('rejects unknown background kind', () => {
    expect(() =>
      createBaselineRenderingPlugin({
        graphics,
        background: {
          kind: 'unknown' as any
        }
      })
    ).toThrow(TypeError);
  });
});

function fixture() {
  const device = new NullDevice();
  const surface = new NullSurface({ id: Symbol('bg-opt-val'), kind: 'offscreen' });
  const graphics = {
    backend: 'webgpu',
    adapter: {} as never,
    device,
    surface,
    lost: new Promise(() => undefined),
    subscribe: () => () => true,
    resize: () => undefined,
    destroy: async () => undefined
  } satisfies BrowserGraphicsSession;
  return { graphics };
}
