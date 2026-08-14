import { bench, expect } from 'vitest';
import {
  NullDevice,
  WebGL2Adapter,
  WebGPUAdapter,
  type WebGL2NativeContextLostInfo,
  type WebGPUNativeAdapterPort,
  type WebGPUNativeCommandEncoderPort,
  type WebGPUNativeComputePassPort,
  type WebGPUNativeDevicePort,
  type WebGPUNativeDeviceRequest,
  type WebGPUNativeRenderPassPort,
  type WebGPUNativeResourcePort,
  type WebGPUNativeTexturePort
} from '../src';

const COMMAND_BUFFER_COUNT = 1_000;

class WebGL2BenchmarkContext {
  readonly info = { name: 'Benchmark WebGL2' };
  readonly extensions = new Set<string>();
  readonly limits = {};
  readonly formats = new Map();
  readonly precision = {};
  readonly lost = new Promise<WebGL2NativeContextLostInfo>(() => undefined);
  createBuffer(): object {
    return {};
  }
  createTexture(): object {
    return {};
  }
}

class WebGPUBenchmarkResource implements WebGPUNativeResourcePort {}
class WebGPUBenchmarkTexture extends WebGPUBenchmarkResource implements WebGPUNativeTexturePort {
  createView(): WebGPUNativeResourcePort {
    return new WebGPUBenchmarkResource();
  }
}

class WebGPUBenchmarkRenderPass implements WebGPUNativeRenderPassPort {
  pushDebugGroup(): void {}
  popDebugGroup(): void {}
  setPipeline(): void {}
  setBindGroup(): void {}
  setVertexBuffer(): void {}
  setIndexBuffer(): void {}
  setViewport(): void {}
  setScissorRect(): void {}
  draw(): void {}
  drawIndexed(): void {}
  drawIndirect(): void {}
  end(): void {}
}

class WebGPUBenchmarkComputePass implements WebGPUNativeComputePassPort {
  pushDebugGroup(): void {}
  popDebugGroup(): void {}
  setPipeline(): void {}
  setBindGroup(): void {}
  dispatchWorkgroups(): void {}
  dispatchWorkgroupsIndirect(): void {}
  end(): void {}
}

class WebGPUBenchmarkEncoder implements WebGPUNativeCommandEncoderPort {
  pushDebugGroup(): void {}
  popDebugGroup(): void {}
  beginRenderPass(): WebGPUNativeRenderPassPort {
    return new WebGPUBenchmarkRenderPass();
  }
  beginComputePass(): WebGPUNativeComputePassPort {
    return new WebGPUBenchmarkComputePass();
  }
  copyBufferToBuffer(): void {}
  copyTextureToTexture(): void {}
  copyBufferToTexture(): void {}
  copyTextureToBuffer(): void {}
  finish(): WebGPUNativeResourcePort {
    return new WebGPUBenchmarkResource();
  }
}

class WebGPUBenchmarkDevice implements WebGPUNativeDevicePort {
  readonly lost = new Promise<never>(() => undefined);
  readonly queue = { submit(): void {}, onSubmittedWorkDone: async () => undefined };
  createBuffer(): WebGPUNativeResourcePort {
    return new WebGPUBenchmarkResource();
  }
  createTexture(): WebGPUNativeTexturePort {
    return new WebGPUBenchmarkTexture();
  }
  createCommandEncoder(): WebGPUNativeCommandEncoderPort {
    return new WebGPUBenchmarkEncoder();
  }
}

class WebGPUBenchmarkAdapter implements WebGPUNativeAdapterPort {
  readonly info = { name: 'Benchmark WebGPU' };
  readonly features = new Set<string>();
  readonly limits = {};
  readonly formats = new Map();
  readonly device = new WebGPUBenchmarkDevice();
  async requestDevice(_request: WebGPUNativeDeviceRequest): Promise<WebGPUNativeDevicePort> {
    return this.device;
  }
}

const WebGL2AdapterConstructor = WebGL2Adapter as unknown as new (
  context: WebGL2BenchmarkContext
) => WebGL2Adapter;
const webgl2Device = await new WebGL2AdapterConstructor(new WebGL2BenchmarkContext()).requestDevice(
  {
    requiredFeatures: [],
    optionalFeatures: []
  }
);
const webgl2Color = webgl2Device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: 16 });
const webgl2ColorView = webgl2Color.createView();
const webgpuDevice = await new WebGPUAdapter(new WebGPUBenchmarkAdapter()).requestDevice({
  requiredFeatures: [],
  optionalFeatures: []
});
const webgpuColor = webgpuDevice.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: 16 });
const webgpuColorView = webgpuColor.createView();

bench(
  'records and submits 1000 deterministic command buffers',
  () => {
    const device = new NullDevice();
    const buffers = [];
    for (let index = 0; index < COMMAND_BUFFER_COUNT; index++) {
      const encoder = device.createCommandEncoder({ label: `frame-${index}` });
      encoder.pushDebugGroup('frame');
      encoder.popDebugGroup();
      buffers.push(encoder.finish());
    }
    const submission = device.queue.submit(buffers);
    expect(submission.status).toBe('completed');
    expect(device.queue.metrics().submitted).toBe(1);
  },
  { iterations: 1, warmupIterations: 0 }
);

bench(
  'records WebGL2 deferred render-pass commands',
  () => {
    let lastDrawCount = -1;
    for (let index = 0; index < COMMAND_BUFFER_COUNT; index++) {
      const encoder = webgl2Device.createCommandEncoder({ label: `webgl2-${index}` });
      encoder.pushDebugGroup('frame');
      encoder.popDebugGroup();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: webgl2ColorView, loadOp: 'load', storeOp: 'store' }]
      });
      pass.setViewport(0, 0, 8, 8, 0, 1);
      pass.setScissorRect(0, 0, 8, 8);
      pass.end();
      const commandBuffer = encoder.finish();
      lastDrawCount = commandBuffer.getStats().draw.drawCalls;
      commandBuffer.dispose();
    }
    expect(lastDrawCount).toBe(0);
  },
  { iterations: 1, warmupIterations: 0 }
);

bench(
  'lowers WebGPU render-pass commands without replay records',
  () => {
    const before = webgpuDevice.fastPathMetrics();
    for (let index = 0; index < COMMAND_BUFFER_COUNT; index++) {
      const encoder = webgpuDevice.createCommandEncoder({ label: `webgpu-${index}` });
      encoder.pushDebugGroup('frame');
      encoder.popDebugGroup();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: webgpuColorView, loadOp: 'load', storeOp: 'store' }]
      });
      pass.setViewport(0, 0, 8, 8, 0, 1);
      pass.setScissorRect(0, 0, 8, 8);
      pass.end();
      encoder.finish().dispose();
    }
    const after = webgpuDevice.fastPathMetrics();
    expect(after.nativeEncoders - before.nativeEncoders).toBe(COMMAND_BUFFER_COUNT);
    expect(after.commandReplayRecordAllocations - before.commandReplayRecordAllocations).toBe(0);
  },
  { iterations: 1, warmupIterations: 0 }
);
