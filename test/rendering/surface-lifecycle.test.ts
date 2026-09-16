import { describe, expect, test, vi } from 'vitest';
import { RenderGraphBuilder } from '../../src/render-graph/builder';
import { compileRenderGraph } from '../../src/render-graph/compiler';
import { createRenderGraphExecutionPlan } from '../../src/render-graph/executor';
import type { RenderGraphExecutionPlan } from '../../src/render-graph';
import { SurfaceRenderPlanCoordinator } from '../../src/rendering/phase/surface-lifecycle';
import { NullDevice } from '../../src/rhi/null/device';
import { NullSurface } from '../../src/rhi/null/surface';
import type { SurfaceTarget } from '../../src/platform/types';

function target(name: string): SurfaceTarget {
  return { id: Symbol(name), kind: 'offscreen' };
}

function configure(surface: NullSurface, device: NullDevice, width: number, height: number): void {
  surface.configure(
    device,
    {
      format: 'rgba8unorm',
      colorSpace: 'srgb',
      alphaMode: 'opaque',
      width,
      height,
      presentMode: 'fifo'
    },
    surface.windowGeneration + 1
  );
}

function buildPlan(width: number, height: number): RenderGraphExecutionPlan {
  const graph = new RenderGraphBuilder();
  graph.createTexture({
    width,
    height,
    depthOrArrayLayers: 1,
    mipLevelCount: 1,
    sampleCount: 1,
    format: 'depth24plus',
    usage: ['depth-stencil-attachment']
  });
  const snapshot = graph.build();
  return createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot));
}

describe('SurfaceRenderPlanCoordinator', () => {
  test('rebuilds the surface-derived plan for a new generation and physical extent', () => {
    const device = new NullDevice();
    const surface = new NullSurface(target('main'));
    const coordinator = new SurfaceRenderPlanCoordinator();
    const build = vi.fn(({ width, height }) => buildPlan(width, height));
    const executed: RenderGraphExecutionPlan[] = [];

    configure(surface, device, 4, 4);
    const first = coordinator.run({ surface, build, execute: (plan) => executed.push(plan) });
    const repeated = coordinator.run({ surface, build, execute: (plan) => executed.push(plan) });
    configure(surface, device, 8, 6);
    const resized = coordinator.run({ surface, build, execute: (plan) => executed.push(plan) });

    expect(first).toMatchObject({ status: 'rendered', cache: 'miss', generation: 1 });
    expect(repeated).toMatchObject({ status: 'rendered', cache: 'hit', generation: 1 });
    expect(resized).toMatchObject({ status: 'rendered', cache: 'miss', generation: 2 });
    expect(build).toHaveBeenCalledTimes(2);
    expect(executed[0]).toBe(executed[1]);
    expect(executed[2]?.snapshot.resources[0]?.descriptor).toMatchObject({ width: 8, height: 6 });
  });

  test('skips zero extent and resumes execution after non-zero reconfiguration', () => {
    const device = new NullDevice();
    const surface = new NullSurface(target('preview'));
    const coordinator = new SurfaceRenderPlanCoordinator();
    const build = vi.fn(({ width, height }) => buildPlan(width, height));
    const execute = vi.fn();

    configure(surface, device, 0, 6);
    const suspended = coordinator.run({ surface, build, execute });

    expect(suspended).toEqual({ status: 'skipped', reason: 'surface-suspended', generation: 1 });
    expect(build).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    configure(surface, device, 8, 6);
    const recovered = coordinator.run({ surface, build, execute });

    expect(recovered).toMatchObject({ status: 'rendered', cache: 'miss', generation: 2 });
    expect(build).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });
});
