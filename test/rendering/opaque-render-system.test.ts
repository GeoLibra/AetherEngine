import { describe, expect, test, vi } from 'vitest';
import {
  NullDevice,
  NullSurface,
  RenderGraphBuilder,
  RenderGraphExecutor,
  createPreparedBindGroupLayoutToken,
  createPreparedRenderPipelineToken,
  RenderSystemRegistry,
  compileRenderSystems,
  createOpaqueRenderSystem,
  type GraphHandle,
  type PreparedDrawPacket,
  type PreparedDrawPhaseSnapshot,
  type RenderEntityId,
  type RenderView,
  type TextureDescriptor
} from '../../src';
import type { RHIBuffer, RHITexture } from '../../src/rhi/contracts';
import type { SurfaceTarget } from '../../src/platform/types';

const COLOR: TextureDescriptor = {
  width: 4,
  height: 4,
  depthOrArrayLayers: 1,
  mipLevelCount: 1,
  sampleCount: 1,
  format: 'rgba8unorm',
  usage: ['color-attachment']
};
const DEPTH: TextureDescriptor = {
  ...COLOR,
  format: 'depth24plus',
  usage: ['depth-stencil-attachment']
};

describe('createOpaqueRenderSystem', () => {
  test('records one indexed draw and transfers resources to the sole submission', () => {
    const device = new NullDevice();
    const retain = vi.fn();
    const release = vi.fn();
    const packet = drawPacket(device, retain, release);
    const prepared = createOpaqueRenderSystem({
      phase: phase(packet),
      surfaceFrame: { kind: 'surface-frame', id: 'main' },
      color: COLOR,
      depth: DEPTH
    });
    const registry = new RenderSystemRegistry();
    registry.add(prepared.descriptor);
    const compiled = compileRenderSystems(registry, { views: [view()] });

    const execution = new RenderGraphExecutor().execute(compiled.plan, {
      device,
      surface: surface(device),
      preparedDrawResources: prepared.preparedDrawResources
    });

    expect(execution.commandStats).toMatchObject({
      renderPasses: 1,
      draw: { indexedDrawCalls: 1, indexCount: 3, instanceCount: 1 }
    });
    expect(retain).toHaveBeenCalledWith(execution.submission);
    expect(release).toHaveBeenCalledOnce();
  });

  test('rejects non-opaque phases and missing attachment usages before graph construction', () => {
    const empty = Object.freeze({
      viewId: 'view:main',
      phase: 'transparent' as const,
      packets: Object.freeze([])
    });
    expect(() =>
      createOpaqueRenderSystem({
        phase: empty,
        surfaceFrame: { kind: 'surface-frame', id: 'main' },
        color: COLOR,
        depth: DEPTH
      })
    ).toThrow(/opaque phase/i);
    expect(() =>
      createOpaqueRenderSystem({
        phase: { ...empty, phase: 'opaque' },
        surfaceFrame: { kind: 'surface-frame', id: 'main' },
        color: { ...COLOR, usage: [] },
        depth: DEPTH
      })
    ).toThrow(/color-attachment usage/i);
  });

  test('records merged background draw when background descriptor is provided in opaque pass', () => {
    const device = new NullDevice();
    const graph = new RenderGraphBuilder();
    const skyTextureHandle = graph.createTexture(
      {
        width: 4,
        height: 4,
        depthOrArrayLayers: 1,
        mipLevelCount: 1,
        sampleCount: 1,
        format: 'rgba8unorm',
        usage: ['sampled']
      },
      {
        origin: {
          kind: 'imported',
          initialState: 'sampled',
          acquire: { kind: 'external-acquire', id: 'sky' }
        }
      }
    );
    const uniformBufferHandle = graph.createBuffer(
      { size: 64, usage: ['uniform'] },
      {
        origin: {
          kind: 'imported',
          initialState: 'uniform',
          acquire: { kind: 'external-acquire', id: 'uniforms' }
        }
      }
    );

    const uniformLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: 1, buffer: { type: 'uniform', minBindingSize: 64 } }]
    });
    const textureLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 1, visibility: 2, sampler: { type: 'filtering' } }
      ]
    });
    const bgPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [uniformLayout, textureLayout] }),
      primitive: { topology: 'triangle-list' }
    });

    const pipelineToken = createPreparedRenderPipelineToken('bg-pipeline');
    const uniformToken = createPreparedBindGroupLayoutToken('bg-uniform-bgl');
    const textureToken = createPreparedBindGroupLayoutToken('bg-texture-bgl');

    const emptyPhase: PreparedDrawPhaseSnapshot = Object.freeze({
      viewId: 'view:main',
      phase: 'opaque',
      packets: Object.freeze([])
    });

    const prepared = createOpaqueRenderSystem({
      phase: emptyPhase,
      surfaceFrame: { kind: 'surface-frame', id: 'main' },
      color: COLOR,
      depth: DEPTH,
      background: {
        pipelineToken,
        uniformLayoutToken: uniformToken,
        textureLayoutToken: textureToken,
        skyTexture: skyTextureHandle,
        uniformBuffer: uniformBufferHandle
      }
    });

    const registry = new RenderSystemRegistry();
    registry.add(prepared.descriptor);
    const compiled = compileRenderSystems(registry, { views: [view()], graph });

    const physicalSky = device.createTexture({
      size: {
        width: 4,
        height: 4,
        depthOrArrayLayers: 1
      },
      mipLevelCount: 1,
      sampleCount: 1,
      format: 'rgba8unorm',
      usage: 1 << 2
    });
    const physicalUniform = device.createBuffer({ size: 64, usage: 1 << 6 });

    const execution = new RenderGraphExecutor().execute(compiled.plan, {
      device,
      surface: surface(device),
      preparedDrawResources: prepared.preparedDrawResources,
      preparedRenderPipelines: new Map([[pipelineToken, bgPipeline]]),
      preparedBindGroupLayouts: new Map([
        [uniformToken, uniformLayout],
        [textureToken, textureLayout]
      ]),
      resources: new Map<GraphHandle, RHITexture | RHIBuffer>([
        [skyTextureHandle, physicalSky],
        [uniformBufferHandle, physicalUniform]
      ])
    });

    expect(execution.commandStats).toMatchObject({
      renderPasses: 1,
      draw: { drawCalls: 1, vertexCount: 3, indexedDrawCalls: 0 }
    });
  });
});

function phase(packet: PreparedDrawPacket): PreparedDrawPhaseSnapshot {
  return Object.freeze({ viewId: 'view:main', phase: 'opaque', packets: Object.freeze([packet]) });
}

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
  const target: SurfaceTarget = { id: Symbol('opaque'), kind: 'offscreen' };
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

function drawPacket(
  device: NullDevice,
  retain: PreparedDrawPacket['retain'],
  release: PreparedDrawPacket['release']
): PreparedDrawPacket {
  const layouts = [0, 1].map(() =>
    device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: 1,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 64 }
        }
      ]
    })
  );
  const uniformBuffers = layouts.map(() => device.createBuffer({ size: 512, usage: 1 << 3 }));
  const bindGroups = layouts.map((layout, index) =>
    device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: uniformBuffers[index]!, size: 64 } }]
    })
  );
  return {
    entity: 1 as RenderEntityId,
    phase: 'opaque',
    pipelineKey: 'pipeline',
    materialKey: 'material',
    meshKey: 'mesh',
    bindingKey: 'binding',
    drawKey: 'draw',
    distance: 1,
    insertionOrder: 0,
    pipeline: device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
      primitive: { topology: 'triangle-list' }
    }),
    bindingSet: {
      bindingKey: {} as never,
      bindGroups,
      dynamicOffsetsByGroup: [[0], [256]],
      deviceGeneration: device.generation
    },
    vertexBuffers: [device.createBuffer({ size: 64, usage: 1 << 5 })],
    indexBuffer: device.createBuffer({ size: 32, usage: 1 << 4 }),
    indexFormat: 'uint16',
    firstIndex: 0,
    indexCount: 3,
    released: false,
    retentionReady: true,
    retain,
    release
  };
}
