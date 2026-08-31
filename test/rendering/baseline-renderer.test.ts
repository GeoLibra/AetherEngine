import { describe, expect, test, vi } from 'vitest';
import {
  BaselineRenderer,
  NullDevice,
  NullSurface,
  type BrowserGraphicsSession,
  type PreparedDrawPacket,
  type RenderEntityId,
  type RenderView
} from '../../src';

describe('BaselineRenderer', () => {
  test('records one indexed draw and one logical submission from a ready snapshot', () => {
    const { device, surface, graphics } = fixture(4, 4);
    const release = vi.fn();
    const renderer = new BaselineRenderer({ graphics });

    const result = renderer.frame({
      status: 'ready',
      view: view(),
      packets: [packet(device, release)],
      deviceGeneration: device.generation,
      surfaceGeneration: surface.generation
    });

    expect(result).toMatchObject({ status: 'rendered', indexedDrawCalls: 1, indexCount: 3 });
    expect(device.queue.metrics().submitted).toBe(1);
    expect(surface.acquiredFrameCount).toBe(1);
    expect(release).toHaveBeenCalledOnce();
  });

  test.each([
    ['pending', 'prepare-pending'],
    ['missing', 'missing-resource']
  ] as const)('does not submit a %s preparation snapshot', (status, reason) => {
    const { device, surface, graphics } = fixture(4, 4);
    const renderer = new BaselineRenderer({ graphics });
    expect(
      renderer.frame({
        status,
        view: view(),
        deviceGeneration: device.generation,
        surfaceGeneration: surface.generation
      })
    ).toMatchObject({ status: 'skipped', reason });
    expect(device.queue.metrics().submitted).toBe(0);
  });

  test('skips zero extent and stale device or surface identities before acquire', () => {
    const zero = fixture(0, 4);
    const zeroRenderer = new BaselineRenderer({ graphics: zero.graphics });
    expect(
      zeroRenderer.frame({
        status: 'ready',
        view: view(),
        packets: [],
        deviceGeneration: zero.device.generation,
        surfaceGeneration: zero.surface.generation
      })
    ).toMatchObject({ status: 'skipped', reason: 'surface-suspended' });
    expect(zero.surface.acquiredFrameCount).toBe(0);

    const current = fixture(4, 4);
    const renderer = new BaselineRenderer({ graphics: current.graphics });
    const base = { status: 'ready' as const, view: view(), packets: [] };
    expect(
      renderer.frame({
        ...base,
        deviceGeneration: current.device.generation + 1,
        surfaceGeneration: current.surface.generation
      })
    ).toMatchObject({ reason: 'stale-device-generation' });
    expect(
      renderer.frame({
        ...base,
        deviceGeneration: current.device.generation,
        surfaceGeneration: current.surface.generation + 1
      })
    ).toMatchObject({ reason: 'stale-surface-generation' });
    expect(current.surface.acquiredFrameCount).toBe(0);
  });

  test('rejects frame use after disposal', () => {
    const { device, surface, graphics } = fixture(4, 4);
    const renderer = new BaselineRenderer({ graphics });
    renderer.dispose();
    expect(() =>
      renderer.frame({
        status: 'missing',
        view: view(),
        deviceGeneration: device.generation,
        surfaceGeneration: surface.generation
      })
    ).toThrow(/disposed/i);
  });
});

function fixture(width: number, height: number) {
  const device = new NullDevice();
  const surface = new NullSurface({ id: Symbol('baseline'), kind: 'offscreen' });
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
    1
  );
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
  return { device, surface, graphics };
}

function view(): RenderView {
  return Object.freeze({
    id: 'main',
    camera: 1 as RenderEntityId,
    surface: 'main',
    viewport: Object.freeze({ x: 0, y: 0, width: 4, height: 4 }),
    layerMask: 1,
    featurePolicyKey: 'baseline',
    historyKey: 'main-history'
  });
}

function packet(device: NullDevice, release: () => void): PreparedDrawPacket {
  const pipeline = device.createRenderPipeline({ primitive: { topology: 'triangle-list' } });
  const indexBuffer = device.createBuffer({ size: 6, usage: 1 << 4 });
  let released = false;
  return Object.freeze({
    entity: 2 as RenderEntityId,
    phase: 'opaque',
    pipelineKey: 'pipeline',
    materialKey: 'material',
    meshKey: 'mesh',
    bindingKey: 'binding',
    drawKey: 'draw',
    distance: 0,
    insertionOrder: 0,
    pipeline,
    bindingSet: Object.freeze({
      bindingKey: Object.freeze({}) as never,
      bindGroups: Object.freeze([]),
      dynamicOffsetsByGroup: Object.freeze([]),
      deviceGeneration: device.generation
    }),
    vertexBuffers: Object.freeze([]),
    indexBuffer,
    indexFormat: 'uint16',
    firstIndex: 0,
    indexCount: 3,
    get released() {
      return released;
    },
    get retentionReady() {
      return !released;
    },
    retain() {},
    release() {
      if (released) return;
      released = true;
      release();
    }
  });
}
