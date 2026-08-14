import { describe, expect, test } from 'vitest';

import {
  WebGL2Adapter,
  WebGL2BrowserSurface,
  type WebGL2NativeContextLostInfo
} from '../../../src';

class SurfaceContext {
  readonly info = { name: 'Surface WebGL2' };
  readonly extensions = new Set<string>();
  readonly limits = {};
  readonly formats = new Map();
  readonly precision = {};
  readonly lost = new Promise<WebGL2NativeContextLostInfo>(() => {});
  readonly presented: unknown[][] = [];
  readonly deleted: object[] = [];
  createTexture(): object {
    return {};
  }
  deleteTexture(texture: object): void {
    this.deleted.push(texture);
  }
  presentSurfaceTexture(texture: object, width: number, height: number): void {
    this.presented.push([texture, width, height]);
  }
}

describe('browser WebGL2 surface', () => {
  test('suspends at zero extent, increments generation, and enforces single-use frames', async () => {
    const native = new SurfaceContext();
    const device = await new WebGL2Adapter(native).requestDevice({
      requiredFeatures: [],
      optionalFeatures: []
    });
    const surface = new WebGL2BrowserSurface({ id: Symbol('canvas'), kind: 'canvas' });
    const configuration = {
      format: 'rgba8unorm' as const,
      colorSpace: 'srgb' as const,
      alphaMode: 'opaque' as const,
      width: 0,
      height: 0,
      presentMode: 'fifo' as const
    };

    surface.configure(device, configuration, 1);
    expect(surface.acquire()).toEqual({ status: 'zero-extent' });
    surface.configure(device, { ...configuration, width: 32, height: 20 }, 2);
    expect(surface.generation).toBe(2);
    const acquired = surface.acquire();
    expect(acquired.status).toBe('success');
    if (acquired.status !== 'success') return;
    expect(surface.acquire()).toEqual({ status: 'timeout' });
    acquired.frame.present();
    expect(native.presented[0]?.slice(1)).toEqual([32, 20]);
    expect(() => acquired.frame.present()).toThrow(/no longer acquired/i);
    expect(native.deleted).toHaveLength(1);
    surface.dispose();
  });
});
