import { describe, expect, test, vi } from 'vitest';
import { RenderGraphBuilder } from '../../src/render-graph/builder';
import { compileRenderGraph } from '../../src/render-graph/compiler';
import {
  RenderGraphExecutor,
  createRenderGraphExecutionPlan
} from '../../src/render-graph/executor';
import type {
  ComputePassContext,
  CopyPassContext,
  RenderGraphExecutionPlan
} from '../../src/render-graph/types';
import type { RHIBindGroupLayout } from '../../src/rhi/contracts';
import { NullDevice } from '../../src/rhi/null/device';

function compile(builder: RenderGraphBuilder): RenderGraphExecutionPlan {
  const snapshot = builder.build();
  return createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot));
}

describe('RenderGraph restricted lifecycle regressions', () => {
  test('keeps capabilities opaque and retires pass-created resources after submission', async () => {
    const device = new NullDevice({ submissionMode: 'manual' });
    const graph = new RenderGraphBuilder();
    let rawLayout: RHIBindGroupLayout | undefined;
    const createLayout = device.createBindGroupLayout.bind(device);
    vi.spyOn(device, 'createBindGroupLayout').mockImplementation((descriptor) => {
      rawLayout = createLayout(descriptor);
      return rawLayout;
    });
    const source = graph.createBuffer(
      { size: 64, usage: ['storage-read'] },
      {
        origin: {
          kind: 'imported',
          initialState: 'storage-read',
          acquire: { kind: 'external-acquire', id: 'opaque-source' }
        }
      }
    );
    let captured: unknown;
    let layout: ReturnType<ComputePassContext['device']['createBindGroupLayout']> | undefined;
    let capturedDevice: ComputePassContext['device'] | undefined;
    graph.addComputePass({
      id: 'opaque-bind-group',
      setup(pass) {
        const input = pass.readBuffer(source, 'storage-read');
        pass.sideEffect('verify restricted ownership');
        return { input };
      },
      run(context: ComputePassContext, resources) {
        capturedDevice = context.device;
        const input = context.buffer(resources.input, 'storage-read');
        layout = context.device.createBindGroupLayout({
          entries: [{ binding: 0, visibility: 4, buffer: { type: 'read-only-storage' } }]
        });
        captured = context.device.createBindGroup({
          layout,
          entries: [{ binding: 0, resource: input }]
        });
        context.compute.setBindGroup(0, captured as never);
      }
    });

    const execution = new RenderGraphExecutor().execute(compile(graph), {
      device,
      resources: new Map([[source, device.createBuffer({ size: 64, usage: 128 })]])
    });
    expect(captured).toEqual({ kind: 'restricted-bind-group' });
    expect(Object.keys(captured as object)).toEqual(['kind']);
    expect(layout).toEqual({ kind: 'restricted-bind-group-layout' });
    expect('dispose' in (layout as object)).toBe(false);
    expect('dispose' in (captured as object)).toBe(false);
    expect(rawLayout?.state).toBe('live');
    expect(() => capturedDevice?.createSampler()).toThrow(/callback ended/i);

    device.queue.completeNextForTesting();
    await execution.submission.done;
    expect(rawLayout?.state).toBe('disposed');
  });

  test('disposes pass-created resources immediately when encoding fails before submit', () => {
    const device = new NullDevice();
    const graph = new RenderGraphBuilder();
    let rawLayout: RHIBindGroupLayout | undefined;
    const createLayout = device.createBindGroupLayout.bind(device);
    vi.spyOn(device, 'createBindGroupLayout').mockImplementation((descriptor) => {
      rawLayout = createLayout(descriptor);
      return rawLayout;
    });
    let layout: ReturnType<CopyPassContext['device']['createBindGroupLayout']> | undefined;
    graph.addCopyPass({
      id: 'failed-pass-resource-owner',
      setup(pass) {
        pass.sideEffect('fail after allocation');
        return undefined;
      },
      run(context: CopyPassContext) {
        layout = context.device.createBindGroupLayout({ entries: [] });
        throw new Error('intentional encode failure');
      }
    });

    expect(() => new RenderGraphExecutor().execute(compile(graph), { device })).toThrow(
      /intentional encode failure/
    );
    expect(layout).toEqual({ kind: 'restricted-bind-group-layout' });
    expect(rawLayout?.state).toBe('disposed');
    expect(device.queue.metrics().submitted).toBe(0);
  });
});
