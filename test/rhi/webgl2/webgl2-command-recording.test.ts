import { describe, expect, test } from 'vitest';

import {
  RHIUnsupportedOperationError,
  WebGL2Adapter,
  type RHICommandRecord,
  type WebGL2NativeContextLostInfo
} from '../../../src';
import type { RHIRenderPassColorAttachment } from '../../../src/rhi/contracts';

class CommandContext {
  readonly info = { name: 'Command WebGL2' };
  readonly extensions = new Set<string>();
  readonly limits = {
    maxUniformBufferBindings: 4,
    maxTextureUnits: 4,
    uniformBufferOffsetAlignment: 256
  };
  readonly formats = new Map();
  readonly precision = {};
  readonly lost = new Promise<WebGL2NativeContextLostInfo>(() => {});
  readonly calls: string[] = [];
  createBuffer(): object { this.calls.push('createBuffer'); return {}; }
  createTexture(): object { this.calls.push('createTexture'); return {}; }
  createProgram(): object { this.calls.push('createProgram'); return {}; }
  getProgramReflection(): readonly [] { this.calls.push('getProgramReflection'); return []; }
  deleteBuffer(): void { this.calls.push('deleteBuffer'); }
  deleteTexture(): void { this.calls.push('deleteTexture'); }
  deleteProgram(): void { this.calls.push('deleteProgram'); }
}

class Translator {
  translate(input: { entryPoint: string }) {
    return { source: `#version 300 es\nvoid ${input.entryPoint}() {}`, bindings: [] };
  }
}

async function createFixture() {
  const native = new CommandContext();
  const Adapter = WebGL2Adapter as unknown as new (
    native: CommandContext,
    translator: Translator
  ) => WebGL2Adapter;
  const device = await new Adapter(native, new Translator()).requestDevice({
    requiredFeatures: [], optionalFeatures: []
  });
  const module = device.createShaderModule({ code: 'portable-ir' });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [] });
  const pipeline = device.createRenderPipeline({
    layout,
    vertex: { module },
    fragment: { module, targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' }
  });
  const color = device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: 16 });
  const vertex = device.createBuffer({ size: 64, usage: 32 });
  const index = device.createBuffer({ size: 64, usage: 16 });
  return { device, native, pipeline, color, vertex, index };
}

describe('WebGL2 deferred command recording', () => {
  test('records immutable replay commands without calling native GL', async () => {
    const { device, native, pipeline, color, vertex, index } = await createFixture();
    const copyTarget = device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: 2 });
    const attachment: RHIRenderPassColorAttachment = {
      view: color.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1]
    };
    const attachments = [attachment];
    const encoder = device.createCommandEncoder({ label: 'frame' });
    native.calls.length = 0;

    encoder.pushDebugGroup('frame');
    encoder.popDebugGroup();
    const pass = encoder.beginRenderPass({ label: 'main', colorAttachments: attachments });
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, vertex, 4, 32);
    pass.setIndexBuffer(index, 'uint16', 0, 24);
    pass.setViewport(0, 0, 8, 8, 0, 1);
    pass.setScissorRect(0, 0, 8, 8);
    pass.draw(3);
    pass.drawIndexed(6, 2);
    pass.end();
    encoder.copyBufferToBuffer(vertex, 0, index, 8, 16);
    encoder.copyTextureToTexture({ texture: color }, { texture: copyTarget }, [4, 4]);

    attachment.loadOp = 'load';
    attachments.length = 0;
    const commandBuffer = encoder.finish({ label: 'recorded-frame' });

    expect(native.calls).toEqual([]);
    expect(commandBuffer.getCommandStream().map((record) => record.kind)).toEqual([
      'pushDebugGroup', 'popDebugGroup', 'beginRenderPass', 'setRenderPipeline',
      'setVertexBuffer', 'setIndexBuffer', 'setViewport', 'setScissorRect',
      'draw', 'drawIndexed', 'endRenderPass', 'copyBufferToBuffer', 'copyTextureToTexture'
    ]);
    expect(commandBuffer.getStats()).toMatchObject({
      renderPasses: 1,
      draw: { drawCalls: 1, indexedDrawCalls: 1, vertexCount: 3, indexCount: 12 },
      copy: { copyBufferToBuffer: 1, copyTextureToTexture: 1 }
    });

    const internal = commandBuffer as typeof commandBuffer & {
      getReplayCommands(): readonly Readonly<Record<string, unknown>>[];
    };
    const replay = internal.getReplayCommands();
    expect(replay[2]).toMatchObject({ kind: 'begin-render-pass' });
    expect(replay[3]).toMatchObject({ kind: 'set-pipeline', pipeline });
    expect(replay[2]?.descriptor).toMatchObject({
      colorAttachments: [{ loadOp: 'clear' }]
    });
    expect(Object.isFrozen(replay[2])).toBe(true);
    const leases = (commandBuffer as typeof commandBuffer & { getLeasedResources(): readonly unknown[] })
      .getLeasedResources();
    expect(leases).toEqual(expect.arrayContaining([color, copyTarget, pipeline, vertex, index]));
  });

  test('snapshots dynamic offsets and returns cloned public records', async () => {
    const { device, native, color } = await createFixture();
    const buffer = device.createBuffer({ size: 1024, usage: 64 });
    const groupLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: 1, buffer: { type: 'uniform', hasDynamicOffset: true } }]
    });
    const group = device.createBindGroup({
      layout: groupLayout, entries: [{ binding: 0, resource: { buffer, offset: 0, size: 256 } }]
    });
    const offsets = [256];
    const encoder = device.createCommandEncoder();
    native.calls.length = 0;
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: color.createView(), loadOp: 'load', storeOp: 'store' }]
    });
    pass.setBindGroup(0, group, offsets);
    offsets[0] = 512;
    pass.end();
    const commandBuffer = encoder.finish();
    const first = commandBuffer.getCommandStream() as RHICommandRecord[];
    const binding = first[1];
    expect(binding).toMatchObject({ kind: 'setBindGroup', dynamicOffsets: [256] });
    if (binding?.kind === 'setBindGroup') (binding.dynamicOffsets as number[])[0] = 768;
    expect(commandBuffer.getCommandStream()[1]).toMatchObject({ dynamicOffsets: [256] });
    expect(native.calls).toEqual([]);
  });

  test('rejects invalid lifecycle and unsupported commands at record time', async () => {
    const { device, pipeline, color, vertex } = await createFixture();
    const encoder = device.createCommandEncoder();
    expect(() => encoder.beginComputePass()).toThrow(expect.objectContaining({
      name: 'RHIUnsupportedOperationError', operation: 'begin-compute-pass'
    } satisfies Partial<RHIUnsupportedOperationError>));
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: color.createView(), loadOp: 'load', storeOp: 'store' }]
    });
    expect(() => pass.draw(3)).toThrow('requires a render pipeline');
    pass.setPipeline(pipeline);
    expect(() => pass.drawIndirect(vertex, 0)).toThrow(expect.objectContaining({
      name: 'RHIUnsupportedOperationError', operation: 'draw-indirect'
    } satisfies Partial<RHIUnsupportedOperationError>));
    expect(() => encoder.finish()).toThrow('while a pass is active');
    pass.pushDebugGroup('open');
    expect(() => pass.end()).toThrow('unclosed debug groups');
    pass.popDebugGroup();
    pass.end();
    expect(() => pass.end()).toThrow('already ended');
    encoder.finish();
    expect(() => encoder.finish()).toThrow('already finished');
  });
});
