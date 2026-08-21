import { describe, expect, test } from 'vitest';
import { RenderGraphBuilder } from '../../src/render-graph/builder';
import { compileRenderGraph } from '../../src/render-graph/compiler';
import {
  RenderGraphExecutor,
  createRenderGraphExecutionPlan,
  type RenderGraphExecutionPlan,
  type RestrictedPassContext
} from '../../src/render-graph/executor';
import {
  createPreparedComputePipelineToken,
  createPreparedRenderPipelineToken
} from '../../src/render-graph/prepared-resources';
import { NullDevice } from '../../src/rhi/null/device';
import { TransientResourcePool } from '../../src/render-graph/transient-pool';
import type { TransientAllocationDescriptor } from '../../src/render-graph/transient-pool';
import type { BufferDescriptor, TextureDescriptor } from '../../src/render-graph/types';

const TEXTURE: TextureDescriptor = {
  width: 4,
  height: 4,
  depthOrArrayLayers: 1,
  mipLevelCount: 1,
  sampleCount: 1,
  format: 'rgba8unorm',
  usage: ['sampled', 'color-attachment', 'copy-src']
};

const BUFFER: BufferDescriptor = { size: 64, usage: ['uniform', 'copy-dst', 'copy-src'] };
const DEPTH_TEXTURE: TextureDescriptor = {
  width: 4,
  height: 4,
  depthOrArrayLayers: 2,
  mipLevelCount: 2,
  sampleCount: 1,
  format: 'depth24plus-stencil8',
  usage: ['sampled', 'depth-stencil-attachment']
};

function compile(builder: RenderGraphBuilder): RenderGraphExecutionPlan {
  const snapshot = builder.build();
  return createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot));
}

function importedBuffer(graph: RenderGraphBuilder, id: string) {
  return graph.createBuffer(BUFFER, {
    origin: {
      kind: 'imported',
      initialState: 'uniform',
      acquire: { kind: 'external-acquire', id }
    }
  });
}

class CountingTransientPool extends TransientResourcePool {
  acquisitions = 0;

  override acquire(descriptor: TransientAllocationDescriptor) {
    this.acquisitions += 1;
    return super.acquire(descriptor);
  }
}

describe('RenderGraphExecutor', () => {
  test('exposes externally prepared render pipelines through typed pass capabilities', () => {
    const device = new NullDevice();
    const pipeline = device.createRenderPipeline({ label: 'prepared' });
    const token = createPreparedRenderPipelineToken('main');
    const graph = new RenderGraphBuilder();
    let resolved: unknown;
    graph.addPass({
      id: 'prepared-pipeline',
      setup(pass) {
        pass.sideEffect('record');
      },
      run(context: RestrictedPassContext) {
        resolved = context.renderPipeline(token);
      }
    });

    new RenderGraphExecutor().execute(compile(graph), {
      device,
      preparedRenderPipelines: new Map([[token, pipeline]])
    });

    expect(resolved).toMatchObject({ kind: 'restricted-render-pipeline' });
  });

  test('exposes externally prepared compute pipelines through typed pass capabilities', () => {
    const device = new NullDevice();
    const pipeline = device.createComputePipeline({ label: 'prepared-compute' });
    const token = createPreparedComputePipelineToken('light-list');
    const graph = new RenderGraphBuilder();
    let resolved: unknown;
    graph.addPass({
      id: 'prepared-compute-pipeline',
      setup(pass) {
        pass.sideEffect('record');
      },
      run(context: RestrictedPassContext) {
        resolved = context.computePipeline(token);
      }
    });

    new RenderGraphExecutor().execute(compile(graph), {
      device,
      preparedComputePipelines: new Map([[token, pipeline]])
    });

    expect(resolved).toMatchObject({ kind: 'restricted-compute-pipeline' });
  });

  test('rejects incompatible or foreign imported physical bindings before recording', () => {
    const device = new NullDevice();
    const graph = new RenderGraphBuilder();
    const imported = importedBuffer(graph, 'incompatible');
    graph.addPass({
      id: 'consume',
      setup(pass) {
        pass.readBuffer(imported, 'uniform');
        pass.sideEffect('consume import');
        return undefined;
      },
      run() {}
    });
    const incompatible = device.createBuffer({ size: 64, usage: 1 });
    const plan = compile(graph);

    expect(() =>
      new RenderGraphExecutor().execute(plan, {
        device,
        resources: new Map([[imported, incompatible]])
      })
    ).toThrow(/descriptor.*incompatible/i);

    const otherDevice = new NullDevice();
    const foreign = device.createBuffer({ size: 64, usage: 76 });
    expect(() =>
      new RenderGraphExecutor().execute(plan, {
        device: otherDevice,
        resources: new Map([[imported, foreign]])
      })
    ).toThrow(/device generation/i);

    const disposed = otherDevice.createBuffer({ size: 64, usage: 76 });
    disposed.dispose();
    expect(() =>
      new RenderGraphExecutor().execute(plan, {
        device: otherDevice,
        resources: new Map([[imported, disposed]])
      })
    ).toThrow(/not a live resource/i);
  });
  test('resolves only this pass declared textures and buffers with their declared usage and range', () => {
    const device = new NullDevice();
    const graph = new RenderGraphBuilder();
    const texture = graph.createTexture(TEXTURE);
    const buffer = importedBuffer(graph, 'constants');
    let context: RestrictedPassContext | undefined;

    graph.addPass({
      id: 'record',
      setup(pass) {
        const color = pass.writeTexture(texture, 'color-attachment');
        const constants = pass.readBuffer(buffer, 'uniform', { offset: 0, size: 16 });
        pass.exportTexture(color, 'copy-src');
        return { color, constants };
      },
      run(passContext: RestrictedPassContext, resources) {
        context = passContext;
        expect(passContext.texture(resources.color, 'color-attachment')).toMatchObject({
          kind: 'restricted-texture-view'
        });
        expect(
          passContext.buffer(resources.constants, 'uniform', { offset: 0, size: 16 })
        ).toMatchObject({
          kind: 'restricted-buffer-slice',
          offset: 0,
          size: 16
        });
        passContext
          .beginRaster({
            colorAttachments: [{ texture: resources.color, loadOp: 'clear', storeOp: 'store' }]
          })
          .end();
      }
    });

    const imported = device.createBuffer({ label: 'constants', size: 64, usage: 76 });
    const execution = new RenderGraphExecutor().execute(compile(graph), {
      device,
      resources: new Map([[buffer, imported]])
    });

    expect(execution.commandStats).toMatchObject({ renderPasses: 1 });
    expect(execution.debug.commandStats).toEqual(execution.commandStats);
    expect(execution.debugIR.commandStats).toEqual(execution.commandStats);
    expect(Object.keys(context as object).sort()).toEqual([
      'beginCompute',
      'beginRaster',
      'buffer',
      'computePipeline',
      'copyBufferToBuffer',
      'device',
      'renderPipeline',
      'texture'
    ]);
    expect((context as unknown as Record<string, unknown>).device).toBeDefined();
    expect((context as unknown as Record<string, unknown>).device).not.toHaveProperty('queue');
    expect((context as unknown as Record<string, unknown>).device).not.toHaveProperty(
      'createCommandEncoder'
    );
    expect((context as unknown as Record<string, unknown>).queue).toBeUndefined();
  });

  test('rejects undeclared, wrong-usage, and out-of-range resource access', () => {
    const device = new NullDevice();
    const graph = new RenderGraphBuilder();
    const first = importedBuffer(graph, 'first');
    const second = importedBuffer(graph, 'second');
    graph.addPass({
      id: 'restrict',
      setup(pass) {
        const declared = pass.readBuffer(first, 'uniform', { offset: 0, size: 16 });
        pass.sideEffect('test restriction');
        return { declared };
      },
      run(context: RestrictedPassContext, resources) {
        expect(() => context.buffer(second, 'uniform')).toThrow(/not declared/i);
        expect(() => context.buffer(resources.declared, 'copy-src')).toThrow(/usage/i);
        expect(() =>
          context.buffer(resources.declared, 'uniform', { offset: 0, size: 32 })
        ).toThrow(/range/i);
      }
    });
    const firstPhysical = device.createBuffer({ size: 64, usage: 76 });
    const secondPhysical = device.createBuffer({ size: 64, usage: 76 });

    new RenderGraphExecutor().execute(compile(graph), {
      device,
      resources: new Map([
        [first, firstPhysical],
        [second, secondPhysical]
      ])
    });
  });

  test('returns a range-scoped texture capability without native view creation escape hatches', () => {
    const device = new NullDevice();
    const graph = new RenderGraphBuilder();
    const depth = graph.createTexture(DEPTH_TEXTURE, {
      origin: {
        kind: 'imported',
        initialState: 'sampled',
        acquire: { kind: 'external-acquire', id: 'depth' }
      }
    });
    graph.addPass({
      id: 'depth-reader',
      setup(pass) {
        const declared = pass.readTexture(depth, 'sampled', {
          baseMipLevel: 1,
          mipLevelCount: 1,
          baseArrayLayer: 1,
          arrayLayerCount: 1,
          aspect: 'depth-only'
        });
        const attached = pass.writeTexture(depth, 'depth-stencil-attachment', {
          baseMipLevel: 1,
          mipLevelCount: 1,
          baseArrayLayer: 1,
          arrayLayerCount: 1,
          aspect: 'depth-only'
        });
        pass.sideEffect('read only one depth subresource');
        return { declared, attached };
      },
      run(context: RestrictedPassContext, resources) {
        const view = context.texture(resources.declared, 'sampled');
        expect(view.range).toEqual({
          kind: 'texture',
          baseMipLevel: 1,
          mipLevelCount: 1,
          baseArrayLayer: 1,
          arrayLayerCount: 1,
          aspect: 'depth-only',
          mipLevelEnd: 2,
          arrayLayerEnd: 2
        });
        expect('texture' in view).toBe(false);
        expect('createView' in view).toBe(false);
        context
          .beginRaster({
            colorAttachments: [],
            depthStencilAttachment: {
              texture: resources.attached,
              depthLoadOp: 'clear',
              depthStoreOp: 'store'
            }
          })
          .end();
      }
    });
    const physical = device.createTexture({
      size: { width: 4, height: 4, depthOrArrayLayers: 2 },
      format: 'depth24plus-stencil8',
      usage: 20,
      mipLevelCount: 2
    });
    const createView = physical.createView.bind(physical);
    let nativeDescriptor: Record<string, unknown> | undefined;
    physical.createView = (descriptor = {}) => {
      nativeDescriptor = descriptor as Record<string, unknown>;
      return createView(descriptor);
    };

    new RenderGraphExecutor().execute(compile(graph), {
      device,
      resources: new Map([[depth, physical]])
    });
    expect(nativeDescriptor).toMatchObject({
      baseMipLevel: 1,
      baseArrayLayer: 1,
      aspect: 'depth-only'
    });
  });

  test('does not require bindings or allocate transients used only by culled passes', () => {
    const device = new NullDevice();
    const pool = new CountingTransientPool(device);
    const graph = new RenderGraphBuilder();
    const imported = importedBuffer(graph, 'culled-import');
    const history = graph.createBuffer(BUFFER, {
      origin: { kind: 'history', key: 'culled-history', slots: 2 },
      historyValid: true
    });
    const transient = graph.createTexture(TEXTURE);
    graph.addPass({
      id: 'culled',
      setup(pass) {
        pass.readBuffer(imported, 'uniform');
        pass.readBuffer(history, 'uniform');
        const output = pass.writeTexture(transient, 'color-attachment');
        return { output };
      },
      run() {}
    });
    graph.addPass({
      id: 'observable',
      setup(pass) {
        pass.sideEffect('keeps only this pass');
        return {};
      },
      run(context: RestrictedPassContext) {
        context.beginCompute().end();
      }
    });

    new RenderGraphExecutor().execute(compile(graph), { device, transientPool: pool });

    expect(pool.acquisitions).toBe(0);
  });

  test('executes a compatible alias plan with one physical transient allocation', () => {
    const device = new NullDevice();
    const pool = new CountingTransientPool(device);
    const graph = new RenderGraphBuilder();
    const first = graph.createBuffer(BUFFER);
    const second = graph.createBuffer(BUFFER);
    for (const [id, handle] of [
      ['first', first],
      ['second', second]
    ] as const) {
      graph.addPass({
        id,
        setup(pass) {
          const output = pass.writeBuffer(handle, 'copy-dst');
          pass.sideEffect(id);
          return { output };
        },
        run() {}
      });
    }

    new RenderGraphExecutor().execute(compile(graph), { device, transientPool: pool });

    expect(pool.acquisitions).toBe(1);
  });

  test('requires a callback to end each pass encoder before it returns', () => {
    const graph = new RenderGraphBuilder();
    graph.addPass({
      id: 'unclosed',
      setup(pass) {
        pass.sideEffect('must record safely');
        return {};
      },
      run(context: RestrictedPassContext) {
        context.beginCompute();
      }
    });

    expect(() =>
      new RenderGraphExecutor().execute(compile(graph), { device: new NullDevice() })
    ).toThrow(/must end the active pass encoder/i);
  });

  test('uses one encoder, one command buffer, and one queue submission for all retained passes', () => {
    const device = new NullDevice({ submissionMode: 'manual' });
    const graph = new RenderGraphBuilder();
    for (const id of ['first', 'second']) {
      graph.addPass({
        id,
        setup(pass) {
          pass.sideEffect(id);
          return {};
        },
        run(context: RestrictedPassContext) {
          context.beginCompute({ label: id }).end();
        }
      });
    }

    const execution = new RenderGraphExecutor().execute(compile(graph), { device });

    expect(execution.commandBuffer.getCommandStream().map((record) => record.kind)).toEqual([
      'beginComputePass',
      'endComputePass',
      'beginComputePass',
      'endComputePass'
    ]);
    expect(execution.commandStats.computePasses).toBe(2);
    expect(device.queue.metrics()).toMatchObject({ submitted: 1, pending: 1 });
    device.queue.completeNextForTesting();
  });

  test('rejects a schedule that omits a retained pass before recording or submitting', () => {
    const device = new NullDevice({ submissionMode: 'manual' });
    let ran = false;
    const graph = new RenderGraphBuilder();
    graph.addPass({
      id: 'required',
      setup(pass) {
        pass.sideEffect('required');
        return {};
      },
      run() {
        ran = true;
      }
    });
    const plan = compile(graph);
    const malformed = Object.freeze({
      ...plan,
      schedule: Object.freeze([plan.schedule[0]!, plan.schedule.at(-1)!])
    });

    expect(() => new RenderGraphExecutor().execute(malformed, { device })).toThrow(
      /canonical render graph execution plan/i
    );
    expect(ran).toBe(false);
    expect(device.queue.metrics().submitted).toBe(0);
  });

  test('preserves the callback error while safely closing an active pass encoder', () => {
    const primary = new Error('callback failed');
    const graph = new RenderGraphBuilder();
    graph.addPass({
      id: 'throws',
      setup(pass) {
        pass.sideEffect('throws');
        return {};
      },
      run(context: RestrictedPassContext) {
        context.beginCompute();
        throw primary;
      }
    });

    expect(() =>
      new RenderGraphExecutor().execute(compile(graph), { device: new NullDevice() })
    ).toThrow(primary);
  });

  test('preserves a callback error when fallback pool disposal throws during cleanup', () => {
    const primary = new Error('callback failed');
    const originalDispose = TransientResourcePool.prototype.dispose;
    TransientResourcePool.prototype.dispose = () => {
      throw new Error('pool cleanup failed');
    };
    const graph = new RenderGraphBuilder();
    graph.addPass({
      id: 'throws',
      setup(pass) {
        pass.sideEffect('throws');
        return {};
      },
      run() {
        throw primary;
      }
    });

    try {
      expect(() =>
        new RenderGraphExecutor().execute(compile(graph), { device: new NullDevice() })
      ).toThrow(primary);
    } finally {
      TransientResourcePool.prototype.dispose = originalDispose;
    }
  });
});
