import { describe, expect, test } from 'vitest';

import {
  WebGL2Adapter,
  type WebGL2BindingManifestEntry,
  type WebGL2NativeContextLostInfo
} from '../src';

interface NativeObject { readonly kind: string; readonly id: number }

class ReplayContext {
  readonly info = { name: 'Replay WebGL2' };
  readonly extensions = new Set<string>();
  readonly limits = { maxUniformBufferBindings: 4, maxTextureUnits: 4, uniformBufferOffsetAlignment: 256 };
  readonly formats = new Map();
  readonly precision = {};
  readonly lost = new Promise<WebGL2NativeContextLostInfo>(() => {});
  readonly calls: Array<{ name: string; args: readonly unknown[] }> = [];
  private nextId = 1;
  failNextDraw = false;
  reflection: readonly WebGL2BindingManifestEntry[] = [];

  createBuffer(): NativeObject { return this.object('buffer'); }
  createTexture(): NativeObject { return this.object('texture'); }
  createSampler(): NativeObject { return this.object('sampler'); }
  createProgram(): NativeObject { return this.object('program'); }
  getProgramReflection(): readonly WebGL2BindingManifestEntry[] { return this.reflection; }
  useProgram(...args: unknown[]): void { this.call('useProgram', args); }
  beginRenderPass(...args: unknown[]): void { this.call('beginRenderPass', args); }
  endRenderPass(...args: unknown[]): void { this.call('endRenderPass', args); }
  setRasterState(...args: unknown[]): void { this.call('setRasterState', args); }
  setDepthStencilState(...args: unknown[]): void { this.call('setDepthStencilState', args); }
  setViewport(...args: unknown[]): void { this.call('setViewport', args); }
  setScissorRect(...args: unknown[]): void { this.call('setScissorRect', args); }
  bindVertexBuffer(...args: unknown[]): void { this.call('bindVertexBuffer', args); }
  bindIndexBuffer(...args: unknown[]): void { this.call('bindIndexBuffer', args); }
  bindUniformBuffer(...args: unknown[]): void { this.call('bindUniformBuffer', args); }
  bindTexture(...args: unknown[]): void { this.call('bindTexture', args); }
  bindSampler(...args: unknown[]): void { this.call('bindSampler', args); }
  draw(...args: unknown[]): void {
    this.call('draw', args);
    if (this.failNextDraw) {
      this.failNextDraw = false;
      throw new Error('injected draw failure');
    }
  }
  drawIndexed(...args: unknown[]): void { this.call('drawIndexed', args); }
  copyBufferToBuffer(...args: unknown[]): void { this.call('copyBufferToBuffer', args); }
  pushDebugGroup(...args: unknown[]): void { this.call('pushDebugGroup', args); }
  popDebugGroup(...args: unknown[]): void { this.call('popDebugGroup', args); }

  private object(kind: string): NativeObject { return { kind, id: this.nextId++ }; }
  private call(name: string, args: readonly unknown[]): void { this.calls.push({ name, args }); }
}

class Translator {
  constructor(private readonly bindings: readonly WebGL2BindingManifestEntry[] = []) {}
  translate(input: { entryPoint: string }) {
    return { source: `#version 300 es\nvoid ${input.entryPoint}() {}`, bindings: this.bindings };
  }
}

async function createFixture(bindings: readonly WebGL2BindingManifestEntry[] = []) {
  const native = new ReplayContext();
  native.reflection = bindings;
  const Adapter = WebGL2Adapter as unknown as new (native: ReplayContext, translator: Translator) => WebGL2Adapter;
  const device = await new Adapter(native, new Translator(bindings)).requestDevice({ requiredFeatures: [], optionalFeatures: [] });
  const shader = device.createShaderModule({ code: 'portable-ir' });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [] });
  const pipeline = device.createRenderPipeline({
    layout, vertex: { module: shader },
    fragment: { module: shader, targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' }
  });
  const color = device.createTexture({ size: [16, 16], format: 'rgba8unorm', usage: 16 });
  const vertex = device.createBuffer({ size: 64, usage: 32 });
  const index = device.createBuffer({ size: 64, usage: 16 });
  return { device, native, pipeline, color, vertex, index };
}

describe('WebGL2 ordered replay and state VM', () => {
  test('replays in order and skips only proven-identical state', async () => {
    const { device, native, pipeline, color, vertex, index } = await createFixture();
    const encoder = device.createCommandEncoder();
    encoder.pushDebugGroup('frame');
    encoder.popDebugGroup();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: color.createView(), loadOp: 'load', storeOp: 'store' }]
    });
    for (let draw = 0; draw < 2; draw += 1) {
      pass.setPipeline(pipeline);
      pass.setViewport(0, 0, 16, 16, 0, 1);
      pass.setScissorRect(0, 0, 16, 16);
      pass.setVertexBuffer(0, vertex, 0, 32);
      pass.setIndexBuffer(index, 'uint16', 0, 12);
      pass.draw(3);
      pass.drawIndexed(6);
    }
    pass.end();
    encoder.copyBufferToBuffer(vertex, 0, index, 16, 8);
    const commands = encoder.finish();

    expect(native.calls).toEqual([]);
    device.queue.submit([commands]);

    const names = native.calls.map((call) => call.name);
    expect(names.slice(0, 4)).toEqual(['pushDebugGroup', 'popDebugGroup', 'beginRenderPass', 'useProgram']);
    expect(names.at(-2)).toBe('endRenderPass');
    expect(names.at(-1)).toBe('copyBufferToBuffer');
    expect(names.filter((name) => name === 'useProgram')).toHaveLength(1);
    expect(names.filter((name) => name === 'setRasterState')).toHaveLength(1);
    expect(names.filter((name) => name === 'setViewport')).toHaveLength(1);
    expect(names.filter((name) => name === 'setScissorRect')).toHaveLength(1);
    expect(names.filter((name) => name === 'bindVertexBuffer')).toHaveLength(1);
    expect(names.filter((name) => name === 'bindIndexBuffer')).toHaveLength(1);
    expect(names.filter((name) => name === 'draw')).toHaveLength(2);
    expect(names.filter((name) => name === 'drawIndexed')).toHaveLength(2);

    expect(device.queue.metrics()).toMatchObject({
      logicalDraws: 4,
      physicalDraws: 4,
      stateSkips: 7,
      multiDrawMerges: 0,
      programCacheHits: 1,
      programCacheMisses: 1
    });
  });

  test('reuses successful state across logical submissions', async () => {
    const { device, native, pipeline, color } = await createFixture();
    const record = () => {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: color.createView(), loadOp: 'load', storeOp: 'store' }]
      });
      pass.setPipeline(pipeline);
      pass.draw(3);
      pass.end();
      return encoder.finish();
    };

    const first = device.queue.submit([record()]);
    const second = device.queue.submit([record()]);
    await Promise.all([first.done, second.done]);

    expect(native.calls.filter((call) => call.name === 'useProgram')).toHaveLength(1);
    expect(device.queue.metrics().stateSkips).toBeGreaterThan(0);
  });

  test('applies explicit portable defaults instead of assuming driver state', async () => {
    const { device, native, color } = await createFixture();
    const shader = device.createShaderModule({ code: 'portable-defaults' });
    const pipeline = device.createRenderPipeline({
      vertex: { module: shader },
      fragment: { module: shader, targets: [{ format: 'rgba8unorm' }] }
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: color.createView(), loadOp: 'load', storeOp: 'store' }]
    });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    native.calls.length = 0;

    const submission = device.queue.submit([encoder.finish()]);
    await submission.done;

    expect(native.calls.filter((call) => call.name === 'setRasterState')).toHaveLength(1);
    expect(native.calls.filter((call) => call.name === 'setDepthStencilState')).toHaveLength(1);
  });

  test('invalidates cached state after a partial replay failure', async () => {
    const { device, native, pipeline, color } = await createFixture();
    const record = () => {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: color.createView(), loadOp: 'load', storeOp: 'store' }]
      });
      pass.setPipeline(pipeline);
      pass.draw(3);
      pass.end();
      return encoder.finish();
    };
    native.calls.length = 0;
    native.failNextDraw = true;

    const failed = device.queue.submit([record()]);
    await expect(failed.done).resolves.toEqual({ status: 'failed', error: expect.any(Error) });
    const completed = device.queue.submit([record()]);
    await completed.done;

    expect(native.calls.filter((call) => call.name === 'useProgram')).toHaveLength(2);
  });

  test('lowers bind groups to cached uniform, texture, and sampler state', async () => {
    const bindings = [
      { group: 0, binding: 0, name: 'Frame', kind: 'uniform-buffer' },
      { group: 0, binding: 1, name: 'color', kind: 'texture' },
      { group: 0, binding: 2, name: 'linear', kind: 'sampler' }
    ] as const;
    const { device, native, color } = await createFixture(bindings);
    const uniform = device.createBuffer({ size: 1024, usage: 64 });
    const sampled = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 4 });
    const sampler = device.createSampler();
    const groupLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: 1, buffer: { type: 'uniform', hasDynamicOffset: true } },
      { binding: 1, visibility: 2, texture: { sampleType: 'float' } },
      { binding: 2, visibility: 2, sampler: { type: 'filtering' } }
    ] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [groupLayout] });
    const group = device.createBindGroup({ layout: groupLayout, entries: [
      { binding: 0, resource: { buffer: uniform, offset: 0, size: 256 } },
      { binding: 1, resource: sampled.createView() },
      { binding: 2, resource: sampler }
    ] });
    const shader = device.createShaderModule({ code: 'binding-ir' });
    const pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shader },
      fragment: { module: shader, targets: [{ format: 'rgba8unorm' }] }
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: color.createView(), loadOp: 'load', storeOp: 'store' }]
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group, [256]);
    pass.setBindGroup(0, group, [256]);
    pass.draw(3);
    pass.end();
    native.calls.length = 0;

    const submission = device.queue.submit([encoder.finish()]);
    await submission.done;

    expect(native.calls.filter((call) => call.name === 'bindUniformBuffer')).toHaveLength(1);
    expect(native.calls.find((call) => call.name === 'bindUniformBuffer')?.args.slice(0, 4)).toEqual([
      0, expect.any(Object), 256, 256
    ]);
    expect(native.calls.filter((call) => call.name === 'bindTexture')).toHaveLength(1);
    expect(native.calls.filter((call) => call.name === 'bindSampler')).toHaveLength(1);
  });
});
