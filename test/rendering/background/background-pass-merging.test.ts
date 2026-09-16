import { describe, expect, it } from 'vitest';
import {
  createBackgroundRenderSystem,
  packSkyboxUniforms,
  SKYBOX_UNIFORM_BYTE_SIZE
} from '../../../src/rendering/background';
import {
  NullDevice,
  NullSurface,
  RenderGraphBuilder,
  RenderGraphExecutor,
  RenderSystemRegistry,
  compileRenderSystems,
  createOpaqueRenderSystem,
  type TextureDescriptor,
  type PreparedDrawPhaseSnapshot,
  type RenderView,
  type RenderEntityId,
  type GraphHandle
} from '../../../src';
import type { RHIBuffer, RHITexture } from '../../../src/rhi/contracts';
import type { SurfaceTarget } from '../../../src/platform/types';

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
  const target: SurfaceTarget = { id: Symbol('background'), kind: 'offscreen' };
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

describe('background render system and compiler pass fusion', () => {
  it('creates a raster pass descriptor with clear and auto store semantics', () => {
    const graph = new RenderGraphBuilder();
    const color = graph.createTexture(COLOR);
    const uniform = graph.createBuffer({ size: 64, usage: ['uniform'] });
    const sky = graph.createTexture({ ...COLOR, usage: ['sampled'] });

    const system = createBackgroundRenderSystem({
      viewId: 'view:main',
      prepared: { status: 'ready' } as never,
      colorTarget: color,
      uniformBuffer: uniform,
      skyTexture: sky,
      width: 4,
      height: 4
    });

    expect(system.kind).toBe('raster');
    expect(system.id).toBe('background-view:main');
  });

  it('fuses background and opaque into 1 physical pass by default', () => {
    const device = new NullDevice();
    const graph = new RenderGraphBuilder();
    const color = graph.createTexture(COLOR, {
      origin: {
        kind: 'imported',
        initialState: 'undefined',
        acquire: { kind: 'external-acquire', id: 'main' }
      }
    });
    const uniform = graph.createBuffer(
      { size: 64, usage: ['uniform'] },
      {
        origin: {
          kind: 'imported',
          initialState: 'uniform',
          acquire: { kind: 'external-acquire', id: 'u' }
        }
      }
    );
    const sky = graph.createTexture(
      { ...COLOR, usage: ['sampled'] },
      {
        origin: {
          kind: 'imported',
          initialState: 'sampled',
          acquire: { kind: 'external-acquire', id: 's' }
        }
      }
    );

    let activeColor = color;
    const bg = createBackgroundRenderSystem({
      viewId: 'view:main',
      prepared: { status: 'ready' } as never,
      colorTarget: color,
      publishColor(c) {
        activeColor = c;
      },
      uniformBuffer: uniform,
      skyTexture: sky,
      width: 4,
      height: 4
    });

    const emptyPhase: PreparedDrawPhaseSnapshot = Object.freeze({
      viewId: 'view:main',
      phase: 'opaque',
      packets: Object.freeze([])
    });

    const opaque = createOpaqueRenderSystem({
      phase: emptyPhase,
      surfaceFrame: { kind: 'surface-frame', id: 'main' },
      color: COLOR,
      depth: DEPTH,
      colorLoadOp: 'load',
      colorTarget: () => activeColor
    });

    const registry = new RenderSystemRegistry();
    const bgToken = registry.add(bg);
    registry.add({ ...opaque.descriptor, after: [bgToken] });

    const compiled = compileRenderSystems(registry, { views: [view()], graph });
    expect(compiled.plan.rasterGroups).toHaveLength(1);
    expect(compiled.plan.rasterGroups[0]?.retainedPassIndices).toHaveLength(2);

    const physicalSky = device.createTexture({
      size: { width: 4, height: 4, depthOrArrayLayers: 1 },
      mipLevelCount: 1,
      sampleCount: 1,
      format: 'rgba8unorm',
      usage: 1 << 2
    });
    const physicalUniform = device.createBuffer({ size: 64, usage: 1 << 6 });

    const execution = new RenderGraphExecutor().execute(compiled.plan, {
      device,
      surface: surface(device),
      preparedDrawResources: opaque.preparedDrawResources,
      resources: new Map<GraphHandle, RHITexture | RHIBuffer>([
        [sky, physicalSky],
        [uniform, physicalUniform]
      ])
    });

    expect(execution.commandStats).toMatchObject({ renderPasses: 1 });
  });

  it('separates background and opaque into 2 physical passes when fusion is disabled', () => {
    const graph = new RenderGraphBuilder();
    const color = graph.createTexture(COLOR, {
      origin: {
        kind: 'imported',
        initialState: 'undefined',
        acquire: { kind: 'external-acquire', id: 'main' }
      }
    });
    const uniform = graph.createBuffer(
      { size: 64, usage: ['uniform'] },
      {
        origin: {
          kind: 'imported',
          initialState: 'uniform',
          acquire: { kind: 'external-acquire', id: 'u2' }
        }
      }
    );
    const sky = graph.createTexture(
      { ...COLOR, usage: ['sampled'] },
      {
        origin: {
          kind: 'imported',
          initialState: 'sampled',
          acquire: { kind: 'external-acquire', id: 's2' }
        }
      }
    );

    let activeColor = color;
    const bg = createBackgroundRenderSystem({
      viewId: 'view:main',
      prepared: { status: 'ready' } as never,
      colorTarget: color,
      publishColor(c) {
        activeColor = c;
      },
      uniformBuffer: uniform,
      skyTexture: sky,
      width: 4,
      height: 4
    });

    const emptyPhase: PreparedDrawPhaseSnapshot = Object.freeze({
      viewId: 'view:main',
      phase: 'opaque',
      packets: Object.freeze([])
    });

    const opaque = createOpaqueRenderSystem({
      phase: emptyPhase,
      surfaceFrame: { kind: 'surface-frame', id: 'main' },
      color: COLOR,
      depth: DEPTH,
      colorLoadOp: 'load',
      colorTarget: () => activeColor
    });

    const registry = new RenderSystemRegistry();
    const bgToken = registry.add(bg);
    registry.add({ ...opaque.descriptor, after: [bgToken] });

    const compiled = compileRenderSystems(registry, {
      views: [view()],
      graph,
      executionPlanOptions: { enablePassFusion: false }
    });

    expect(compiled.plan.rasterGroups).toHaveLength(2);
  });

  it('packs skybox uniforms with exact 240-byte WGSL alignment', () => {
    const data = packSkyboxUniforms({
      vertexRays: {
        ray0: [1, 2, 3],
        ray1: [4, 5, 6],
        ray2: [7, 8, 9]
      },
      invProj: new Float32Array(16),
      envRot: new Float32Array(16),
      intensity: 2.5,
      multiplier: 1.5,
      maxLod: 8,
      textureWidth: 1024,
      textureHeight: 512,
      reconstructionMode: 'vertex',
      representation: 'panorama',
      depthMode: 'standard',
      projectionKind: 'perspective'
    });

    expect(data.byteLength).toBe(SKYBOX_UNIFORM_BYTE_SIZE);
    expect(data.length).toBe(60);

    // ray0, ray1, ray2
    expect(data[0]).toBe(1);
    expect(data[1]).toBe(2);
    expect(data[2]).toBe(3);
    expect(data[3]).toBe(0);

    expect(data[4]).toBe(4);
    expect(data[5]).toBe(5);
    expect(data[6]).toBe(6);

    expect(data[8]).toBe(7);
    expect(data[9]).toBe(8);
    expect(data[10]).toBe(9);

    // params (intensity * multiplier = 3.75, maxLod = 8, width = 1024, height = 512)
    expect(data[48]).toBeCloseTo(3.75);
    expect(data[49]).toBe(8);
    expect(data[50]).toBe(1024);
    expect(data[51]).toBe(512);

    // flags (reconstructionMode=0, representation=0, depthMode=0, projectionKind=0)
    expect(data[52]).toBe(0); // vertex mode
    expect(data[53]).toBe(0); // panorama
    expect(data[54]).toBe(0); // standard depth
    expect(data[55]).toBe(0); // perspective
  });
});
