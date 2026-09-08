import { describe, expect, it, vi } from 'vitest';
import { NullDevice } from '../../../src/rhi';
import { Mat4, STANDARD_DEPTH } from '../../../src/math';
import {
  prepareBackground,
  prepareBackgroundPipeline,
  clearBackgroundPipelineCache,
  packSkyboxUniforms
} from '../../../src/rendering/background';
import { EnvironmentTextureCache } from '../../../src/rendering/lighting/environment';
import { validateOptions } from '../../../src/rendering/baseline/baseline-options';
import type { ExtractedView } from '../../../src/rendering/camera';
import type { BrowserGraphicsSession } from '../../../src/platform';
import type { EnvironmentAsset } from '../../../src/assets';

const view = {
  viewId: 'review',
  view: Mat4.identity(),
  projection: Mat4.perspective(Math.PI / 3, 1, 0.1, 100, STANDARD_DEPTH),
  projectionKind: 'perspective'
} as unknown as ExtractedView;

describe('background ownership regressions', () => {
  it('isolates devices even when their generation numbers collide', () => {
    const firstDevice = new NullDevice();
    const secondDevice = new NullDevice();
    // Backends have independent generation counters. Reproduce that collision deterministically.
    Object.defineProperty(secondDevice, 'generation', { value: firstDevice.generation });
    const first = prepareBackgroundPipeline(firstDevice, { colorFormat: 'rgba16float' });
    const second = prepareBackgroundPipeline(secondDevice, { colorFormat: 'rgba16float' });
    expect(first.prepared.pipeline).not.toBe(second.prepared.pipeline);
    first.release();
    clearBackgroundPipelineCache(firstDevice);
    expect(first.prepared.pipeline.state).toBe('disposed');
    expect(second.prepared.pipeline.state).toBe('live');
    second.release();
    clearBackgroundPipelineCache(secondDevice);
  });

  it('retires cache entries only after local leases and all submissions finish', async () => {
    const device = new NullDevice();
    const frame = prepareBackground({
      device,
      view,
      background: { kind: 'solid', colorLinear: [1, 1, 1] },
      colorFormat: 'rgba16float',
      environmentCache: new EnvironmentTextureCache()
    });
    let completeFirst!: () => void;
    let completeSecond!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      completeFirst = resolve;
    });
    const secondDone = new Promise<void>((resolve) => {
      completeSecond = resolve;
    });
    frame.retain({
      id: 1,
      status: 'pending',
      done: firstDone.then(() => ({ status: 'completed' }))
    });
    frame.retain({
      id: 2,
      status: 'pending',
      done: secondDone.then(() => ({ status: 'completed' }))
    });
    clearBackgroundPipelineCache(device);
    frame.release();
    expect(frame.pipeline!.state).toBe('live');
    expect(frame.uniformBuffer!.state).toBe('live');
    completeFirst();
    await firstDone;
    await Promise.resolve();
    expect(frame.uniformBuffer!.state).toBe('live');
    completeSecond();
    await secondDone;
    await Promise.resolve();
    expect(frame.pipeline!.state).toBe('disposed');
    expect(frame.uniformBuffer!.state).toBe('disposed');
    expect(() => frame.retain()).toThrow(/released/);
  });

  it('does not compile another pipeline for a warm frame or another camera', () => {
    const device = new NullDevice();
    const compile = vi.spyOn(device, 'createRenderPipeline');
    const options = {
      device,
      view,
      background: { kind: 'solid', colorLinear: [1, 1, 1] } as const,
      colorFormat: 'rgba16float' as const,
      environmentCache: new EnvironmentTextureCache()
    };
    const first = prepareBackground(options);
    const second = prepareBackground({ ...options, view: { ...view, viewId: 'other' } });
    expect(compile).toHaveBeenCalledTimes(1);
    first.release();
    second.release();
    clearBackgroundPipelineCache(device);
  });
});

describe('environment lighting boundary', () => {
  const graphics = {} as BrowserGraphicsSession;

  it('preserves the baseline HDR exposure calibration when an asset omits lighting overrides', () => {
    const environment = {} as EnvironmentAsset;
    const options = validateOptions({ graphics, environment });

    expect(options.environmentLighting).toEqual({
      intensity: 1,
      radianceTint: [100, 120, 180],
      diffuseIrradiance: [300, 350, 500]
    });
  });

  it('rejects non-finite intensity and malformed or negative tint', () => {
    for (const intensity of [NaN, Infinity, -1]) {
      expect(() => validateOptions({ graphics, environmentLighting: { intensity } })).toThrow();
    }
    expect(() =>
      validateOptions({ graphics, environmentLighting: { radianceTint: [1, -1, 1] } })
    ).toThrow();
    expect(() =>
      validateOptions({ graphics, environmentLighting: { diffuseIrradiance: [1, NaN, 1] } })
    ).toThrow();
  });

  it('owns caller tint data and sends the same gain to the sky uniform', () => {
    const tint: [number, number, number] = [0.25, 0.5, 1];
    const options = validateOptions({
      graphics,
      environmentLighting: { intensity: 2, radianceTint: tint }
    });
    tint[0] = 100;
    expect(options.environmentLighting.radianceTint).toEqual([0.25, 0.5, 1]);
    const uniform = packSkyboxUniforms({
      vertexRays: { ray0: [0, 0, -1], ray1: [0, 0, -1], ray2: [0, 0, -1] },
      invProj: Mat4.identity(),
      envRot: Mat4.identity(),
      intensity: options.environmentLighting.intensity,
      radianceTint: options.environmentLighting.radianceTint,
      multiplier: 3,
      maxLod: 0,
      textureWidth: 1,
      textureHeight: 1,
      reconstructionMode: 'vertex',
      representation: 'panorama',
      depthMode: 'standard',
      projectionKind: 'perspective'
    });
    expect([...uniform.slice(12, 15)]).toEqual([0.25, 0.5, 1]);
    expect(uniform[48]).toBe(6);
  });
});
