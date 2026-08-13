import { describe, expect, test } from 'vitest';
import { WebGPUAdapter, requestBrowserWebGPUAdapter } from '../../../src';

describe('browser WebGPU command and queue ports', () => {
  test('records directly into one native encoder and submits its command buffer once', async () => {
    const trace: string[] = [];
    const nativeCommandBuffer = {};
    const nativeRenderPass = {
      setPipeline(): void { trace.push('pass.setPipeline'); },
      draw(): void { trace.push('pass.draw'); },
      end(): void { trace.push('pass.end'); },
      pushDebugGroup(): void {}, popDebugGroup(): void {}, setBindGroup(): void {},
      setVertexBuffer(): void {}, setIndexBuffer(): void {}, setViewport(): void {},
      setScissorRect(): void {}, drawIndexed(): void {}, drawIndirect(): void {}
    };
    const nativeEncoder = {
      beginRenderPass(): object { trace.push('encoder.beginRenderPass'); return nativeRenderPass; },
      finish(): object { trace.push('encoder.finish'); return nativeCommandBuffer; },
      pushDebugGroup(): void {}, popDebugGroup(): void {}, copyBufferToBuffer(): void {},
      copyTextureToTexture(): void {}, copyBufferToTexture(): void {}, copyTextureToBuffer(): void {},
      beginComputePass(): object { throw new Error('not used'); }
    };
    let encoderCount = 0;
    const submissions: readonly object[][] = [];
    const nativeDevice = createNativeDevice({
      createCommandEncoder(): object { encoderCount += 1; return nativeEncoder; },
      queue: {
        submit(commandBuffers: readonly object[]): void {
          (submissions as object[][]).push([...commandBuffers]);
        },
        async onSubmittedWorkDone(): Promise<void> {}
      }
    });
    const device = await createDevice(nativeDevice);
    const texture = device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: 16 });
    const shader = device.createShaderModule({ code: '@vertex fn main() {}' });
    const pipeline = device.createRenderPipeline({ vertex: { module: shader } });
    const encoder = device.createCommandEncoder({ label: 'frame' });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store' }]
    });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    const commandBuffer = encoder.finish();
    const submission = device.queue.submit([commandBuffer]);

    await expect(submission.done).resolves.toEqual({ status: 'completed' });
    expect(encoderCount).toBe(1);
    expect(trace).toEqual([
      'encoder.beginRenderPass', 'pass.setPipeline', 'pass.draw', 'pass.end', 'encoder.finish'
    ]);
    expect(submissions).toEqual([[nativeCommandBuffer]]);
  });

  test('rejects a command resource owned by another browser device', async () => {
    const first = await createDevice(createNativeDevice());
    const second = await createDevice(createNativeDevice());
    const foreign = first.createBuffer({ size: 16, usage: 1 });
    const local = second.createBuffer({ size: 16, usage: 1 });
    const encoder = second.createCommandEncoder();

    expect(() => encoder.copyBufferToBuffer(foreign, 0, local, 0, 16)).toThrow(
      'belongs to a different WebGPUDevice'
    );
  });
});

async function createDevice(nativeDevice: object) {
  const nativeAdapter = {
    info: { description: 'Command GPU' },
    features: new Set<string>(),
    limits: { maxBufferSize: 4096 },
    async requestDevice(): Promise<object> { return nativeDevice; }
  };
  const port = await requestBrowserWebGPUAdapter({
    gpu: { async requestAdapter(): Promise<object> { return nativeAdapter; } },
    getCanvasContext(): null { return null; }
  }, {});
  if (port === null) throw new Error('Expected adapter.');
  return new WebGPUAdapter(port).requestDevice({ requiredFeatures: [], optionalFeatures: [] });
}

function createNativeDevice(overrides: Readonly<Record<string, unknown>> = {}): object {
  const queue = overrides.queue ?? { submit(): void {}, async onSubmittedWorkDone(): Promise<void> {} };
  return {
    lost: new Promise(() => undefined),
    queue,
    createBuffer(): object { return { size: 16, usage: 1, destroy(): void {} }; },
    createTexture(): object { return { createView(): object { return {}; }, destroy(): void {} }; },
    createShaderModule(): object { return {}; },
    createRenderPipeline(): object { return {}; },
    createCommandEncoder: overrides.createCommandEncoder ?? (() => ({
      pushDebugGroup(): void {}, popDebugGroup(): void {},
      beginRenderPass(): object { throw new Error('not used'); },
      beginComputePass(): object { throw new Error('not used'); },
      copyBufferToBuffer(): void {}, copyTextureToTexture(): void {},
      finish(): object { return {}; }
    })),
    addEventListener(): void {}, removeEventListener(): void {}
  };
}
