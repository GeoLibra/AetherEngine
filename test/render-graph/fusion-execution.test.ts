/**
 * Tests for physical raster pass group execution, state isolation, and lifecycle safety.
 *
 * Verifies that:
 * 1. RasterPassContext and RasterCommands are revoked immediately upon pass callback completion.
 * 2. Pipeline and index buffer bindings are isolated per logical pass scope within the same physical pass.
 * 3. Full viewport and scissor rectangles are restored across member boundaries.
 * 4. End-to-end execution on NullDevice fuses compatible raster passes into a single physical pass.
 * 5. Exceptions thrown in member callbacks safely terminate the active physical render pass.
 */

import { describe, expect, test, vi, type MockInstance } from 'vitest';
import { RenderGraphBuilder } from '../../src/render-graph/builder';
import { compileRenderGraph } from '../../src/render-graph/compiler';
import {
  RenderGraphExecutor,
  createRenderGraphExecutionPlan
} from '../../src/render-graph/executor';
import { NullDevice } from '../../src/rhi/null/device';
import type {
  BufferDescriptor,
  RasterPassContext,
  TextureDescriptor
} from '../../src/render-graph/types';

const COLOR_DESC: TextureDescriptor = Object.freeze({
  width: 16,
  height: 16,
  depthOrArrayLayers: 1,
  mipLevelCount: 1,
  sampleCount: 1,
  format: 'rgba8unorm',
  usage: Object.freeze(['color-attachment', 'copy-src'] as const)
});

const BUFFER_DESC: BufferDescriptor = Object.freeze({
  size: 64,
  usage: Object.freeze(['vertex', 'index', 'copy-dst'] as const)
});

describe('fusion execution and state isolation', () => {
  test('revokes RasterCommands and RasterPassContext upon callback return', () => {
    const builder = new RenderGraphBuilder();
    const color = builder.createTexture(COLOR_DESC);

    let leakedContext: RasterPassContext | undefined;

    builder.addRasterPass({
      id: 'pass-leak',
      setup(pass) {
        pass.colorAttachment(0, color, { load: 'clear', store: 'store' });
        pass.sideEffect('leak');
        return {};
      },
      run(context) {
        leakedContext = context;
      }
    });

    const snapshot = builder.build();
    const plan = createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot));
    const executor = new RenderGraphExecutor();
    const device = new NullDevice();

    executor.execute(plan, { device });

    expect(leakedContext).toBeDefined();
    // Invocations outside callback scope must throw fail-fast error
    expect(() => leakedContext!.raster.draw(3)).toThrow(
      'Cannot invoke raster commands outside of the active pass callback scope.'
    );
    expect(() => leakedContext!.raster.setViewport(0, 0, 16, 16)).toThrow(
      'Cannot invoke raster commands outside of the active pass callback scope.'
    );
  });

  test('enforces logical state isolation for pipeline binding across fused members', () => {
    const builder = new RenderGraphBuilder();
    const color = builder.createTexture(COLOR_DESC);

    let member2Error: Error | undefined;

    let currentColor = color;
    // Member 1 sets pipeline and draws
    builder.addRasterPass({
      id: 'member-1',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, { load: 'clear', store: 'auto' });
        pass.sideEffect('draw-1');
        return {};
      },
      run(context) {
        const pipeline = context.device.createRenderPipeline({
          layout: context.device.createPipelineLayout({ bindGroupLayouts: [] }),
          vertex: {
            module: context.device.createShaderModule({ code: '@vertex fn main() {}' }),
            entryPoint: 'main'
          },
          primitive: { topology: 'triangle-list' },
          fragment: {
            module: context.device.createShaderModule({ code: '@fragment fn main() {}' }),
            entryPoint: 'main',
            targets: [{ format: 'rgba8unorm' }]
          }
        });
        context.raster.setPipeline(pipeline);
        context.raster.draw(3);
      }
    });

    // Member 2 does NOT set pipeline and attempts to draw
    builder.addRasterPass({
      id: 'member-2',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, { load: 'load', store: 'store' });
        pass.sideEffect('draw-2');
        return {};
      },
      run(context) {
        try {
          context.raster.draw(3);
        } catch (err) {
          member2Error = err as Error;
        }
      }
    });

    const snapshot = builder.build();
    const plan = createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot));
    const executor = new RenderGraphExecutor();
    const device = new NullDevice();

    executor.execute(plan, { device });

    expect(member2Error).toBeDefined();
    expect(member2Error!.message).toContain(
      'Draw requires setPipeline() to be called within the logical pass scope.'
    );
  });

  test('enforces index buffer requirement for drawIndexed', () => {
    const builder = new RenderGraphBuilder();
    const color = builder.createTexture(COLOR_DESC);

    let drawIndexedError: Error | undefined;

    builder.addRasterPass({
      id: 'member-indexed',
      setup(pass) {
        pass.colorAttachment(0, color, { load: 'clear', store: 'store' });
        pass.sideEffect('indexed');
        return {};
      },
      run(context) {
        const pipeline = context.device.createRenderPipeline({
          layout: context.device.createPipelineLayout({ bindGroupLayouts: [] }),
          vertex: {
            module: context.device.createShaderModule({ code: '@vertex fn main() {}' }),
            entryPoint: 'main'
          },
          primitive: { topology: 'triangle-list' },
          fragment: {
            module: context.device.createShaderModule({ code: '@fragment fn main() {}' }),
            entryPoint: 'main',
            targets: [{ format: 'rgba8unorm' }]
          }
        });
        context.raster.setPipeline(pipeline);
        try {
          context.raster.drawIndexed(6);
        } catch (err) {
          drawIndexedError = err as Error;
        }
      }
    });

    const snapshot = builder.build();
    const plan = createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot));
    const executor = new RenderGraphExecutor();
    const device = new NullDevice();

    executor.execute(plan, { device });

    expect(drawIndexedError).toBeDefined();
    expect(drawIndexedError!.message).toContain(
      'DrawIndexed requires setIndexBuffer() to be called within the logical pass scope.'
    );
  });

  test('restores full viewport and scissor rect at member boundaries', () => {
    const builder = new RenderGraphBuilder();
    const color = builder.createTexture(COLOR_DESC);

    let currentColor = color;
    builder.addRasterPass({
      id: 'member-1-scissor',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, { load: 'clear', store: 'auto' });
        pass.sideEffect('m1');
        return {};
      },
      run(context) {
        // Narrow the viewport and scissor
        context.raster.setViewport(2, 2, 4, 4, 0.1, 0.9);
        context.raster.setScissorRect(2, 2, 4, 4);
      }
    });

    builder.addRasterPass({
      id: 'member-2-restored',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, { load: 'load', store: 'store' });
        pass.sideEffect('m2');
        return {};
      },
      run() {}
    });

    const snapshot = builder.build();
    const plan = createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot));
    const device = new NullDevice();

    const beginSpy = vi.spyOn(device, 'createCommandEncoder');
    let setViewportSpy: MockInstance | undefined;
    let setScissorSpy: MockInstance | undefined;

    const originalBegin = device.createCommandEncoder.bind(device);
    vi.spyOn(device, 'createCommandEncoder').mockImplementation((desc) => {
      const encoder = originalBegin(desc);
      const origBeginPass = encoder.beginRenderPass.bind(encoder);
      vi.spyOn(encoder, 'beginRenderPass').mockImplementation((passDesc) => {
        const pass = origBeginPass(passDesc);
        setViewportSpy = vi.spyOn(pass, 'setViewport');
        setScissorSpy = vi.spyOn(pass, 'setScissorRect');
        return pass;
      });
      return encoder;
    });

    const executor = new RenderGraphExecutor();
    executor.execute(plan, { device });

    expect(setViewportSpy).toBeDefined();
    expect(setScissorSpy).toBeDefined();

    // Member 1 setViewport(0,0,16,16,0,1) then custom(2,2,4,4)
    // Member 2 restored setViewport(0,0,16,16,0,1)
    const viewportCalls = setViewportSpy!.mock.calls;
    expect(viewportCalls.length).toBeGreaterThanOrEqual(3);
    // The call right before member 2 must be the full viewport restore
    expect(viewportCalls[viewportCalls.length - 1]).toEqual([0, 0, 16, 16, 0, 1]);

    const scissorCalls = setScissorSpy!.mock.calls;
    expect(scissorCalls.length).toBeGreaterThanOrEqual(3);
    expect(scissorCalls[scissorCalls.length - 1]).toEqual([0, 0, 16, 16]);
  });

  test('fuses adjacent compatible raster passes into 1 physical pass on NullDevice', () => {
    const builder = new RenderGraphBuilder();
    const color = builder.createTexture(COLOR_DESC);

    let currentColor = color;
    builder.addRasterPass({
      id: 'bg-pass',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, { load: 'clear', store: 'auto' });
        pass.sideEffect('bg');
        return {};
      },
      run() {}
    });

    builder.addRasterPass({
      id: 'opaque-pass',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, { load: 'load', store: 'store' });
        pass.sideEffect('opaque');
        return {};
      },
      run() {}
    });

    const snapshot = builder.build();
    const device = new NullDevice();
    const executor = new RenderGraphExecutor();

    // With fusion enabled (default)
    const fusedPlan = createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot), {
      enablePassFusion: true
    });
    const fusedResult = executor.execute(fusedPlan, { device });
    expect(fusedResult.commandStats.renderPasses).toBe(1);

    // With fusion disabled
    const unfusedPlan = createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot), {
      enablePassFusion: false
    });
    const unfusedResult = executor.execute(unfusedPlan, { device });
    expect(unfusedResult.commandStats.renderPasses).toBe(2);
  });

  test('ensures render pass is ended when a member callback throws', () => {
    const builder = new RenderGraphBuilder();
    const color = builder.createTexture(COLOR_DESC);

    let currentColor = color;
    builder.addRasterPass({
      id: 'ok-member',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, { load: 'clear', store: 'auto' });
        pass.sideEffect('ok');
        return {};
      },
      run() {}
    });

    builder.addRasterPass({
      id: 'throwing-member',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, { load: 'load', store: 'store' });
        pass.sideEffect('throw');
        return {};
      },
      run() {
        throw new Error('Explosion in member pass!');
      }
    });

    const snapshot = builder.build();
    const plan = createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot));
    const device = new NullDevice();

    let endCalled = false;
    const originalBegin = device.createCommandEncoder.bind(device);
    vi.spyOn(device, 'createCommandEncoder').mockImplementation((desc) => {
      const encoder = originalBegin(desc);
      const origBeginPass = encoder.beginRenderPass.bind(encoder);
      vi.spyOn(encoder, 'beginRenderPass').mockImplementation((passDesc) => {
        const pass = origBeginPass(passDesc);
        const origEnd = pass.end.bind(pass);
        vi.spyOn(pass, 'end').mockImplementation(() => {
          endCalled = true;
          origEnd();
        });
        return pass;
      });
      return encoder;
    });

    const executor = new RenderGraphExecutor();
    expect(() => executor.execute(plan, { device })).toThrow('Explosion in member pass!');
    expect(endCalled).toBe(true);
  });
});
