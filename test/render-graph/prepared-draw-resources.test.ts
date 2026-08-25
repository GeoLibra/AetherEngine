import { describe, expect, test, vi } from 'vitest';
import {
  NullDevice,
  RenderGraphBuilder,
  RenderGraphExecutor,
  compileRenderGraph,
  createPreparedDrawResourcesToken,
  createRenderGraphExecutionPlan,
  type PreparedDrawPacket,
  type RenderEntityId,
  type RestrictedPassContext
} from '../../src';

describe('prepared draw resources', () => {
  test('exposes only restricted capabilities and transfers packet ownership after submit', () => {
    const device = new NullDevice();
    const token = createPreparedDrawResourcesToken('opaque:0');
    const retain = vi.fn();
    const release = vi.fn();
    const packet = drawPacket(device, retain, release);
    const graph = new RenderGraphBuilder();
    let resolved: ReturnType<RestrictedPassContext['drawResources']> | undefined;
    graph.addPass({
      id: 'opaque',
      setup(pass) {
        pass.sideEffect('indexed draw');
      },
      run(context: RestrictedPassContext) {
        resolved = context.drawResources(token);
      }
    });
    const snapshot = graph.build();
    const plan = createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot));

    const execution = new RenderGraphExecutor().execute(plan, {
      device,
      preparedDrawResources: new Map([[token, packet]])
    });

    expect(resolved).toMatchObject({
      pipeline: { kind: 'restricted-render-pipeline' },
      bindGroups: [{ kind: 'restricted-bind-group' }],
      vertexBuffers: [{ kind: 'restricted-buffer-slice', offset: 0, size: 64 }],
      indexBuffer: { kind: 'restricted-buffer-slice', offset: 0, size: 32 },
      indexFormat: 'uint16',
      firstIndex: 0,
      indexCount: 3
    });
    expect(resolved).not.toHaveProperty('packet');
    expect(retain).toHaveBeenCalledWith(execution.submission);
    expect(release).toHaveBeenCalledOnce();
  });

  test('does not transfer packet ownership when recording fails before submit', () => {
    const device = new NullDevice();
    const token = createPreparedDrawResourcesToken('opaque:failure');
    const retain = vi.fn();
    const release = vi.fn();
    const graph = new RenderGraphBuilder();
    graph.addPass({
      id: 'failure',
      setup(pass) {
        pass.sideEffect('fail');
      },
      run() {
        throw new Error('recording failed');
      }
    });
    const snapshot = graph.build();

    expect(() =>
      new RenderGraphExecutor().execute(
        createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot)),
        { device, preparedDrawResources: new Map([[token, drawPacket(device, retain, release)]]) }
      )
    ).toThrow('recording failed');
    expect(retain).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});

function drawPacket(
  device: NullDevice,
  retain: PreparedDrawPacket['retain'],
  release: PreparedDrawPacket['release']
): PreparedDrawPacket {
  const layout = device.createBindGroupLayout({ entries: [] });
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
    pipeline: device.createRenderPipeline({}),
    bindingSet: {
      bindingKey: {} as never,
      bindGroups: [device.createBindGroup({ layout, entries: [] })],
      dynamicOffsets: [],
      deviceGeneration: device.generation
    },
    vertexBuffers: [device.createBuffer({ size: 64, usage: 1 << 5 })],
    indexBuffer: device.createBuffer({ size: 32, usage: 1 << 4 }),
    indexFormat: 'uint16',
    firstIndex: 0,
    indexCount: 3,
    released: false,
    retain,
    release
  };
}
