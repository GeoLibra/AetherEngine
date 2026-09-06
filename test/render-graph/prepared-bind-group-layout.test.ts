import { describe, expect, test } from 'vitest';
import {
  NullDevice,
  RenderGraphBuilder,
  RenderGraphExecutor,
  compileRenderGraph,
  createPreparedBindGroupLayoutToken,
  createRenderGraphExecutionPlan,
  type RestrictedBindGroupLayout,
  type RestrictedPassContext
} from '../../src';

describe('prepared bind-group layouts', () => {
  test('resolves an externally prepared layout inside the synchronous pass boundary', () => {
    const device = new NullDevice();
    const token = createPreparedBindGroupLayoutToken('light-list');
    const layout = device.createBindGroupLayout({ entries: [] });
    const graph = new RenderGraphBuilder();
    let resolved: RestrictedBindGroupLayout | undefined;
    graph.addPass({
      id: 'resolve-layout',
      setup(pass) {
        pass.sideEffect('resolve prepared layout');
      },
      run(context: RestrictedPassContext) {
        resolved = context.bindGroupLayout(token);
        context.device.createBindGroup({ layout: resolved, entries: [] });
      }
    });
    const snapshot = graph.build();

    new RenderGraphExecutor().execute(
      createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot)),
      { device, preparedBindGroupLayouts: new Map([[token, layout]]) }
    );

    expect(resolved).toEqual({ kind: 'restricted-bind-group-layout' });
  });

  test('rejects a prepared layout from another device generation before recording', () => {
    const device = new NullDevice();
    const foreign = new NullDevice();
    const token = createPreparedBindGroupLayoutToken('foreign');
    const graph = new RenderGraphBuilder();
    graph.addPass({
      id: 'unused',
      setup(pass) {
        pass.sideEffect('validate bindings');
      },
      run() {}
    });
    const snapshot = graph.build();

    expect(() =>
      new RenderGraphExecutor().execute(
        createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot)),
        {
          device,
          preparedBindGroupLayouts: new Map([
            [token, foreign.createBindGroupLayout({ entries: [] })]
          ])
        }
      )
    ).toThrow('belongs to another device generation');
  });
});
