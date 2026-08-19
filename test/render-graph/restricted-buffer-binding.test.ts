import { describe, expect, test } from 'vitest';
import {
  RenderGraphBuilder,
  RenderGraphExecutor,
  compileRenderGraph,
  createRenderGraphExecutionPlan,
  NullDevice,
  type RestrictedPassContext
} from '../../src';

describe('RenderGraph restricted vertex/index bindings', () => {
  test('lowers a declared index slice without exposing its physical buffer', () => {
    const device = new NullDevice();
    const physical = device.createBuffer({ size: 72, usage: 1 << 4 });
    const graph = new RenderGraphBuilder();
    const index = graph.createBuffer(
      { size: 72, usage: ['index'] },
      {
        origin: {
          kind: 'imported',
          initialState: 'index',
          acquire: { kind: 'external-acquire', id: 'cube-index' }
        }
      }
    );
    const color = graph.createTexture({
      width: 4,
      height: 4,
      depthOrArrayLayers: 1,
      mipLevelCount: 1,
      sampleCount: 1,
      format: 'rgba8unorm',
      usage: ['color-attachment', 'copy-src']
    });
    graph.addPass({
      id: 'indexed',
      setup(pass) {
        const output = pass.writeTexture(color, 'color-attachment');
        const indices = pass.readBuffer(index, 'index');
        pass.exportTexture(output, 'copy-src');
        return { output, indices };
      },
      run(context: RestrictedPassContext, resources) {
        const indices = context.buffer(resources.indices, 'index');
        const pass = context.beginRaster({
          colorAttachments: [{ texture: resources.output, loadOp: 'clear', storeOp: 'store' }]
        });
        pass.setIndexBuffer(indices, 'uint16');
        pass.end();
      }
    });
    const snapshot = graph.build();
    const plan = createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot));

    expect(() =>
      new RenderGraphExecutor().execute(plan, {
        device,
        resources: new Map([[index, physical]])
      })
    ).not.toThrow();
  });
});
