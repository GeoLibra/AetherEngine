import { describe, expect, test } from 'vitest';
import { RenderGraphBuilder, type SurfaceFrameToken } from '../../src/render-graph/builder';
import { compileRenderGraph } from '../../src/render-graph/compiler';
import {
  RenderGraphExecutor,
  createRenderGraphExecutionPlan,
  type RenderGraphExecutionPlan,
  type RestrictedPassContext
} from '../../src/render-graph/executor';
import { NullDevice } from '../../src/rhi/null/device';
import { NullSurface } from '../../src/rhi/null/surface';
import type { RHISurface, RHISurfaceFrame } from '../../src/rhi/contracts/surface';
import type { SurfaceTarget } from '../../src/platform/types';
import type { TextureDescriptor } from '../../src/render-graph/types';

const TEXTURE: TextureDescriptor = {
  width: 4,
  height: 4,
  depthOrArrayLayers: 1,
  mipLevelCount: 1,
  sampleCount: 1,
  format: 'rgba8unorm',
  usage: ['color-attachment', 'copy-src']
};

function compile(builder: RenderGraphBuilder): RenderGraphExecutionPlan {
  const snapshot = builder.build();
  return createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot));
}

function target(name: string): SurfaceTarget {
  return { id: Symbol(name), kind: 'offscreen' };
}

function configuredSurface(device: NullDevice): NullSurface {
  const surface = new NullSurface(target('executor'));
  surface.configure(
    device,
    {
      format: 'rgba8unorm',
      colorSpace: 'srgb',
      alphaMode: 'opaque',
      width: 4,
      height: 4,
      presentMode: 'fifo'
    },
    1
  );
  return surface;
}

function presentPlan(token: SurfaceFrameToken, throwDuringRun = false): RenderGraphExecutionPlan {
  const graph = new RenderGraphBuilder();
  const output = graph.createTexture(TEXTURE, {
    origin: {
      kind: 'imported',
      initialState: 'undefined',
      acquire: { kind: 'external-acquire', id: token.id }
    }
  });
  graph.addPass({
    id: 'present',
    setup(pass) {
      const color = pass.writeTexture(output, 'color-attachment');
      pass.presentTexture(color, token);
      return { color };
    },
    run(context: RestrictedPassContext, resources) {
      if (throwDuringRun) throw new Error('encode failed');
      context
        .beginRaster({
          colorAttachments: [{ texture: resources.color, loadOp: 'clear', storeOp: 'store' }]
        })
        .end();
    }
  });
  return compile(graph);
}

describe('surface-backed RenderGraph execution', () => {
  test('returns acquire failure without creating an encoder or terminal frame outcome', () => {
    const device = new NullDevice();
    const surface = configuredSurface(device);
    surface.enqueueAcquireStatusForTesting('outdated');

    expect(() =>
      new RenderGraphExecutor().execute(presentPlan({ kind: 'surface-frame', id: 'main' }), {
        device,
        surface
      })
    ).toThrow(/surface acquisition failed: outdated/i);
    expect(surface.acquiredFrameCount).toBe(0);
  });

  test('releases an acquired frame when plan validation, encode, or submit fails', () => {
    const token = { kind: 'surface-frame' as const, id: 'main' };
    const invalidDevice = new NullDevice();
    const invalidSurface = configuredSurface(invalidDevice);
    const malformed = presentPlan(token);
    const invalidPlan = { ...malformed, compiled: { ...malformed.compiled, graphId: -1 } };
    expect(() =>
      new RenderGraphExecutor().execute(invalidPlan, {
        device: invalidDevice,
        surface: invalidSurface
      })
    ).toThrow(/graph id/i);
    expect(invalidSurface.acquire().status).toBe('success');

    const encodeDevice = new NullDevice();
    const encodeSurface = configuredSurface(encodeDevice);
    const encodePlan = presentPlan(token, true);
    expect(() =>
      new RenderGraphExecutor().execute(encodePlan, {
        device: encodeDevice,
        surface: encodeSurface
      })
    ).toThrow('encode failed');
    expect(encodeSurface.acquire().status).toBe('success');

    const submitDevice = new NullDevice();
    const submitSurface = configuredSurface(submitDevice);
    submitDevice.queue.submit = () => {
      throw new Error('submit failed');
    };
    expect(() =>
      new RenderGraphExecutor().execute(presentPlan(token), {
        device: submitDevice,
        surface: submitSurface
      })
    ).toThrow('submit failed');
    expect(submitSurface.acquire().status).toBe('success');
  });

  test('presents exactly once after successful submission', () => {
    const device = new NullDevice();
    const surface = configuredSurface(device);

    new RenderGraphExecutor().execute(presentPlan({ kind: 'surface-frame', id: 'main' }), {
      device,
      surface
    });

    expect(surface.acquire().status).toBe('success');
  });

  test('releases exactly once when present throws while the frame is still acquired', () => {
    const device = new NullDevice();
    const base = configuredSurface(device);
    const releases: string[] = [];
    const surface: RHISurface = {
      target: base.target,
      get state() {
        return base.state;
      },
      get generation() {
        return base.generation;
      },
      get configuration() {
        return base.configuration;
      },
      configure(device, configuration, windowGeneration) {
        base.configure(device, configuration, windowGeneration);
      },
      acquire() {
        const acquired = base.acquire();
        if (acquired.status !== 'success') return acquired;
        const frame: RHISurfaceFrame = {
          texture: acquired.frame.texture,
          generation: acquired.frame.generation,
          get state() {
            return acquired.frame.state;
          },
          present() {
            throw new Error('present failed');
          },
          release() {
            releases.push('release');
            acquired.frame.release();
          }
        };
        return { status: 'success', frame };
      },
      dispose() {
        base.dispose();
      }
    };

    expect(() =>
      new RenderGraphExecutor().execute(presentPlan({ kind: 'surface-frame', id: 'main' }), {
        device,
        surface
      })
    ).toThrow('present failed');
    expect(releases).toEqual(['release']);
    expect(base.acquire().status).toBe('success');
  });
});
