import { describe, expect, test } from 'vitest';
import { NullDevice } from '../../../src';

const BUFFER_USAGE_VERTEX = 1;
const BUFFER_USAGE_INDEX = 2;
const BUFFER_USAGE_INDIRECT = 4;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 16;

function createRenderTarget(device: NullDevice) {
  const color = device.createTexture({
    label: 'color',
    size: { width: 16, height: 8, depthOrArrayLayers: 1 },
    format: 'rgba8unorm',
    usage: TEXTURE_USAGE_RENDER_ATTACHMENT
  });

  return device.createRenderTarget({
    label: 'main-target',
    width: 16,
    height: 8,
    colorAttachments: [
      {
        texture: color,
        format: 'rgba8unorm',
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: [0, 0, 0, 1]
      }
    ]
  });
}

describe('NullDevice command encoding', () => {
  test('validates render pass ordering', () => {
    const device = new NullDevice();
    const encoder = device.createCommandEncoder({ label: 'frame' });
    const pass = encoder.beginRenderPass(createRenderTarget(device).createRenderPassDescriptor());

    expect(() => encoder.finish()).toThrow('Cannot finish command encoder while a pass is active.');
    expect(() => encoder.beginComputePass()).toThrow(
      'Cannot begin a compute pass while another pass is active.'
    );

    pass.end();

    expect(() => pass.end()).toThrow('Render pass "main-target" has already ended.');

    encoder.finish({ label: 'commands' });

    expect(() => encoder.beginRenderPass(createRenderTarget(device).createRenderPassDescriptor())).toThrow(
      'Command encoder "frame" has already finished.'
    );
  });

  test('rejects encoder debug groups and disposed resources in invalid states', () => {
    const device = new NullDevice();
    const encoder = device.createCommandEncoder({ label: 'frame' });
    const pass = encoder.beginRenderPass(createRenderTarget(device).createRenderPassDescriptor());
    const vertex = device.createBuffer({ label: 'disposed-vertex', size: 16, usage: BUFFER_USAGE_VERTEX });

    expect(() => encoder.pushDebugGroup('bad')).toThrow(
      'Cannot push an encoder debug group while a pass is active.'
    );

    vertex.dispose();

    expect(() => pass.setVertexBuffer(0, vertex)).toThrow(
      'Resource "disposed-vertex" has been disposed.'
    );

    pass.end();

    const commandBuffer = encoder.finish({ label: 'disposed-commands' });
    commandBuffer.dispose();

    expect(() => device.queue.submit([commandBuffer])).toThrow(
      'Resource "disposed-commands" has been disposed.'
    );
  });

  test('returns mapped buffer ranges for the requested byte slice', async () => {
    const device = new NullDevice();
    const buffer = device.createBuffer({ label: 'mapped', size: 16, usage: BUFFER_USAGE_VERTEX });

    await buffer.mapAsync(0, 4, 8);

    const mapped = buffer.getMappedRange(6, 4);
    new Uint8Array(mapped).set([1, 2, 3, 4]);

    expect(mapped.byteLength).toBe(4);
    expect(() => buffer.mapAsync(0)).toThrow('Buffer "mapped" is already mapped.');
    expect(() => buffer.getMappedRange(2, 4)).toThrow(
      'Mapped range 2..6 is outside mapped buffer range 4..12.'
    );

    buffer.unmap();
    await buffer.mapAsync(0, 4, 8);

    expect(Array.from(new Uint8Array(buffer.getMappedRange(6, 4)))).toEqual([1, 2, 3, 4]);
  });

  test('rejects cross-device command resources and unbalanced debug groups', () => {
    const firstDevice = new NullDevice();
    const secondDevice = new NullDevice();
    const foreignBuffer = firstDevice.createBuffer({
      label: 'foreign-vertices',
      size: 16,
      usage: BUFFER_USAGE_VERTEX
    });
    const encoder = secondDevice.createCommandEncoder();
    const pass = encoder.beginRenderPass(createRenderTarget(secondDevice).createRenderPassDescriptor());

    expect(() => pass.setVertexBuffer(0, foreignBuffer)).toThrow(
      'Resource "foreign-vertices" belongs to a different NullDevice.'
    );

    pass.pushDebugGroup('open');

    expect(() => pass.end()).toThrow('Render pass "main-target" has unclosed debug groups.');
  });

  test('rejects command buffers submitted to another device queue', () => {
    const firstDevice = new NullDevice();
    const secondDevice = new NullDevice();
    const commandBuffer = firstDevice.createCommandEncoder().finish({ label: 'foreign-commands' });

    expect(() => secondDevice.queue.submit([commandBuffer])).toThrow(
      'Resource "foreign-commands" belongs to a different NullDevice.'
    );
  });

  test('collects draw and compute statistics from command encoding', () => {
    const device = new NullDevice();
    const indirect = device.createBuffer({
      label: 'indirect-draw',
      size: 64,
      usage: BUFFER_USAGE_INDIRECT
    });
    const index = device.createBuffer({
      label: 'indices',
      size: 64,
      usage: BUFFER_USAGE_INDEX
    });
    const pipeline = device.createRenderPipeline({
      label: 'triangles',
      primitive: { topology: 'triangle-list' }
    });
    const encoder = device.createCommandEncoder();
    const renderPass = encoder.beginRenderPass(createRenderTarget(device).createRenderPassDescriptor());

    renderPass.setPipeline(pipeline);
    renderPass.setIndexBuffer(index, 'uint16');
    renderPass.draw(6, 2);
    renderPass.drawIndexed(3, 4);
    renderPass.drawIndirect(indirect, 0);
    renderPass.end();

    const computePass = encoder.beginComputePass({ label: 'cull' });
    computePass.setPipeline(device.createComputePipeline({ label: 'compute-cull' }));
    computePass.dispatchWorkgroups(4, 2, 1);
    computePass.dispatchWorkgroupsIndirect(indirect, 16);
    computePass.end();

    const commandBuffer = encoder.finish();

    expect(encoder.getStats()).toEqual(commandBuffer.getStats());
    expect(commandBuffer.getStats()).toEqual({
      renderPasses: 1,
      computePasses: 1,
      draw: {
        drawCalls: 1,
        indexedDrawCalls: 1,
        indirectDrawCalls: 1,
        instanceCount: 6,
        vertexCount: 12,
        indexCount: 12,
        unknownVertexOrIndexCount: true,
        triangleCountEstimate: 8
      },
      compute: {
        dispatchWorkgroups: 1,
        dispatchWorkgroupsIndirect: 1
      },
      copy: {
        copyBufferToBuffer: 0,
        copyTextureToTexture: 0,
        copyBufferToTexture: 0,
        copyTextureToBuffer: 0
      }
    });
  });

  test('exposes deterministic command stream snapshots', () => {
    const device = new NullDevice();
    const encoder = device.createCommandEncoder({ label: 'frame' });
    const pass = encoder.beginRenderPass(createRenderTarget(device).createRenderPassDescriptor());

    const pipeline = device.createRenderPipeline({ label: 'opaque-pipeline' });
    pass.setPipeline(pipeline);
    pass.pushDebugGroup('opaque');
    pass.draw(3);
    pass.popDebugGroup();
    pass.end();

    const commandBuffer = encoder.finish({ label: 'finished-frame' });

    expect(commandBuffer.getCommandStream()).toEqual([
      { kind: 'beginRenderPass', label: 'main-target', colorAttachmentCount: 1 },
      { kind: 'setRenderPipeline', pipeline: { kind: 'render-pipeline', id: pipeline.id, label: 'opaque-pipeline' } },
      { kind: 'pushDebugGroup', scope: 'render-pass', label: 'opaque' },
      { kind: 'draw', vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
      { kind: 'popDebugGroup', scope: 'render-pass' },
      { kind: 'endRenderPass', label: 'main-target' }
    ]);
    expect(commandBuffer.toCommandStreamJSON()).toBe(
      JSON.stringify(commandBuffer.getCommandStream())
    );
  });
});
