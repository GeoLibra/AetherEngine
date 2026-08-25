import { describe, expect, test, vi } from 'vitest';
import { NullDevice, NullSurface, type RenderEntityId, type RenderView } from '../../src';
import type { SurfaceTarget } from '../../src/platform/types';
import { createE2EDrawPacket, executeOpaqueScene } from './opaque-scene';

describe('executeOpaqueScene', () => {
  test('compiles prepared packets through one opaque RenderSystem submission', () => {
    const device = new NullDevice();
    const retain = vi.fn();
    const release = vi.fn();
    const indexBuffer = device.createBuffer({ size: 6, usage: 1 << 4 });
    const pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [] }),
      primitive: { topology: 'triangle-list' }
    });
    const packet = createE2EDrawPacket({
      entity: 1 as RenderEntityId,
      drawKey: 'triangle',
      pipeline,
      indexBuffer,
      indexFormat: 'uint16',
      indexCount: 3,
      retain,
      release
    });

    const result = executeOpaqueScene({
      device,
      surface: surface(device),
      view: view(),
      surfaceFrame: { kind: 'surface-frame', id: 'main' },
      width: 4,
      height: 4,
      colorFormat: 'rgba8unorm',
      packets: [packet]
    });

    expect(result.renderPath).toBe('opaque-render-system');
    expect(result.renderSystemInstances).toEqual(['opaque-draw@view:view%3Amain']);
    expect(result.execution.commandStats).toMatchObject({
      renderPasses: 1,
      draw: { drawCalls: 0, indexedDrawCalls: 1, indexCount: 3 }
    });
    expect(retain).toHaveBeenCalledWith(result.execution.submission);
    expect(release).toHaveBeenCalledOnce();
  });
});

function view(): RenderView {
  return Object.freeze({
    id: 'view:main',
    camera: 1 as RenderEntityId,
    surface: 'main',
    viewport: Object.freeze({ x: 0, y: 0, width: 4, height: 4 }),
    layerMask: 1,
    featurePolicyKey: 'policy',
    historyKey: 'history'
  });
}

function surface(device: NullDevice): NullSurface {
  const target: SurfaceTarget = { id: Symbol('opaque-e2e'), kind: 'offscreen' };
  const result = new NullSurface(target);
  result.configure(
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
  return result;
}
