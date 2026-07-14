import { describe, expect, test } from 'vitest';
import {
  NullDevice,
  NullSurface,
  type RHISurfaceConfiguration,
  type SurfaceTarget
} from '../src';

const CONFIGURATION: RHISurfaceConfiguration = Object.freeze({
  format: 'rgba8unorm',
  colorSpace: 'srgb',
  alphaMode: 'opaque',
  width: 640,
  height: 360,
  presentMode: 'fifo'
});

function createTarget(name: string): SurfaceTarget {
  return Object.freeze({ id: Symbol(name), kind: 'offscreen' });
}

describe('NullSurface', () => {
  test('configures immutable snapshots and advances surface generation', () => {
    const surface = new NullSurface(createTarget('main'));
    const device = new NullDevice();
    const mutable = { ...CONFIGURATION };

    surface.configure(device, mutable, 4);
    mutable.width = 1;

    expect(surface.state).toBe('configured');
    expect(surface.generation).toBe(1);
    expect(surface.windowGeneration).toBe(4);
    expect(surface.configuration).toEqual(CONFIGURATION);
    expect(Object.isFrozen(surface.configuration)).toBe(true);

    surface.configure(device, { ...CONFIGURATION, width: 800 }, 5);
    expect(surface.generation).toBe(2);
    expect(surface.windowGeneration).toBe(5);
  });

  test('returns zero-extent without allocating a frame texture', () => {
    const surface = new NullSurface(createTarget('minimized'));
    const device = new NullDevice();
    surface.configure(device, { ...CONFIGURATION, width: 0, height: 0 }, 1);

    expect(surface.acquire()).toEqual({ status: 'zero-extent' });
    expect(surface.acquiredFrameCount).toBe(0);
  });

  test('rejects invalid configuration and acquire before configuration', () => {
    const surface = new NullSurface(createTarget('invalid'));
    const device = new NullDevice();

    expect(() => surface.acquire()).toThrow('NullSurface must be configured before acquire.');
    expect(() => surface.configure(device, { ...CONFIGURATION, width: -1 }, 1)).toThrow(
      'Surface width must be a non-negative integer.'
    );
    expect(() => surface.configure(device, CONFIGURATION, -1)).toThrow(
      'Window generation must be a non-negative integer.'
    );
  });

  test('enforces acquire and present/release ordering', () => {
    const surface = new NullSurface(createTarget('ordered'));
    const device = new NullDevice();
    surface.configure(device, CONFIGURATION, 1);

    const acquired = surface.acquire();
    expect(acquired.status).toBe('success');
    if (acquired.status !== 'success') throw new Error('Expected a frame.');
    expect(surface.acquire()).toEqual({ status: 'timeout' });
    expect(acquired.frame.generation).toBe(surface.generation);
    expect(acquired.frame.texture.descriptor).toMatchObject({
      size: { width: 640, height: 360, depthOrArrayLayers: 1 },
      format: 'rgba8unorm'
    });

    acquired.frame.present();
    expect(acquired.frame.state).toBe('presented');
    expect(acquired.frame.texture.state).toBe('disposed');
    expect(() => acquired.frame.present()).toThrow('Surface frame has already been presented.');
    expect(() => acquired.frame.release()).toThrow('Presented surface frame cannot be released.');

    const next = surface.acquire();
    if (next.status !== 'success') throw new Error('Expected a second frame.');
    next.frame.release();
    expect(next.frame.state).toBe('released');
    expect(() => next.frame.present()).toThrow('Released surface frame cannot be presented.');
  });

  test('reports deterministic outdated, loss, OOM, and device-loss outcomes', () => {
    const surface = new NullSurface(createTarget('failure'));
    const device = new NullDevice();
    surface.configure(device, CONFIGURATION, 1);

    surface.enqueueAcquireStatusForTesting('outdated');
    surface.enqueueAcquireStatusForTesting('out-of-memory');
    expect(surface.acquire()).toEqual({ status: 'outdated' });
    expect(surface.acquire()).toEqual({ status: 'out-of-memory' });

    surface.loseForTesting();
    expect(surface.state).toBe('lost');
    expect(surface.acquire()).toEqual({ status: 'lost' });

    surface.configure(device, CONFIGURATION, 2);
    device.loseForTesting('context-lost', 'device lost');
    expect(surface.acquire()).toEqual({ status: 'device-lost' });
  });

  test('keeps surface state independent per target and rejects use after dispose', () => {
    const device = new NullDevice();
    const first = new NullSurface(createTarget('first'));
    const second = new NullSurface(createTarget('second'));
    first.configure(device, CONFIGURATION, 1);
    second.configure(device, { ...CONFIGURATION, width: 320 }, 7);

    first.loseForTesting();
    expect(first.acquire()).toEqual({ status: 'lost' });
    expect(second.acquire().status).toBe('success');
    expect(second.generation).toBe(1);
    expect(second.windowGeneration).toBe(7);

    first.dispose();
    expect(first.state).toBe('disposed');
    expect(() => first.configure(device, CONFIGURATION, 2)).toThrow('NullSurface has been disposed.');
    expect(() => first.acquire()).toThrow('NullSurface has been disposed.');
  });
});
