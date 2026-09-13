import { describe, expect, test } from 'vitest';
import {
  RenderGraphBuilder,
  compileRenderGraph,
  createRenderGraphExecutionPlan,
  RenderGraphExecutor,
  type TextureDescriptor,
  type BufferDescriptor
} from '../../src/render-graph';
import {
  WebGPUAdapter,
  type WebGPUNativeAdapterPort,
  type WebGPUNativeCommandEncoderPort,
  type WebGPUNativeComputePassPort,
  type WebGPUNativeDevicePort,
  type WebGPUNativeDeviceRequest,
  type WebGPUNativeRenderPassPort,
  type WebGPUNativeResourcePort,
  type WebGPUNativeTexturePort,
  type RHISurface
} from '../../src';
import { TransientResourcePool } from '../../src/render-graph/executor';

class Handle implements WebGPUNativeResourcePort {}

class TextureHandle extends Handle implements WebGPUNativeTexturePort {
  createView(): WebGPUNativeResourcePort {
    return new Handle();
  }
}

class RenderPass implements WebGPUNativeRenderPassPort {
  constructor(private readonly calls: string[]) {}
  pushDebugGroup(): void {
    this.calls.push('render.pushDebugGroup');
  }
  popDebugGroup(): void {
    this.calls.push('render.popDebugGroup');
  }
  setPipeline(): void {
    this.calls.push('render.setPipeline');
  }
  setBindGroup(): void {
    this.calls.push('render.setBindGroup');
  }
  setVertexBuffer(): void {
    this.calls.push('render.setVertexBuffer');
  }
  setIndexBuffer(): void {
    this.calls.push('render.setIndexBuffer');
  }
  setViewport(): void {
    this.calls.push('render.setViewport');
  }
  setScissorRect(): void {
    this.calls.push('render.setScissorRect');
  }
  draw(): void {
    this.calls.push('render.draw');
  }
  drawIndexed(): void {
    this.calls.push('render.drawIndexed');
  }
  drawIndirect(): void {
    this.calls.push('render.drawIndirect');
  }
  end(): void {
    this.calls.push('render.end');
  }
}

class ComputePass implements WebGPUNativeComputePassPort {
  constructor(private readonly calls: string[]) {}
  pushDebugGroup(): void {
    this.calls.push('compute.pushDebugGroup');
  }
  popDebugGroup(): void {
    this.calls.push('compute.popDebugGroup');
  }
  setPipeline(): void {
    this.calls.push('compute.setPipeline');
  }
  setBindGroup(): void {
    this.calls.push('compute.setBindGroup');
  }
  dispatchWorkgroups(): void {
    this.calls.push('compute.dispatchWorkgroups');
  }
  dispatchWorkgroupsIndirect(): void {
    this.calls.push('compute.dispatchWorkgroupsIndirect');
  }
  end(): void {
    this.calls.push('compute.end');
  }
}

class NativeEncoder implements WebGPUNativeCommandEncoderPort {
  constructor(readonly calls: string[]) {}
  pushDebugGroup(): void {
    this.calls.push('encoder.pushDebugGroup');
  }
  popDebugGroup(): void {
    this.calls.push('encoder.popDebugGroup');
  }
  beginRenderPass(): WebGPUNativeRenderPassPort {
    this.calls.push('encoder.beginRenderPass');
    return new RenderPass(this.calls);
  }
  beginComputePass(): WebGPUNativeComputePassPort {
    this.calls.push('encoder.beginComputePass');
    return new ComputePass(this.calls);
  }
  copyBufferToBuffer(): void {
    this.calls.push('encoder.copyBufferToBuffer');
  }
  copyTextureToTexture(): void {
    this.calls.push('encoder.copyTextureToTexture');
  }
  copyBufferToTexture(): void {
    this.calls.push('encoder.copyBufferToTexture');
  }
  copyTextureToBuffer(): void {
    this.calls.push('encoder.copyTextureToBuffer');
  }
  finish(): WebGPUNativeResourcePort {
    this.calls.push('encoder.finish');
    return new Handle();
  }
}

class NativeDevice implements WebGPUNativeDevicePort {
  readonly lost = new Promise<never>(() => undefined);
  readonly calls: string[] = [];
  readonly queue = {
    submit: () => {
      this.calls.push('queue.submit');
    },
    onSubmittedWorkDone: async () => undefined
  };
  createBuffer(): WebGPUNativeResourcePort {
    return new Handle();
  }
  createTexture(): WebGPUNativeTexturePort {
    return new TextureHandle();
  }
  createSampler(): WebGPUNativeResourcePort {
    return new Handle();
  }
  createShaderModule(): WebGPUNativeResourcePort {
    return new Handle();
  }
  createBindGroupLayout(): WebGPUNativeResourcePort {
    return new Handle();
  }
  createPipelineLayout(): WebGPUNativeResourcePort {
    return new Handle();
  }
  createBindGroup(): WebGPUNativeResourcePort {
    return new Handle();
  }
  createRenderPipeline(): WebGPUNativeResourcePort {
    return new Handle();
  }
  createComputePipeline(): WebGPUNativeResourcePort {
    return new Handle();
  }
  createCommandEncoder(): WebGPUNativeCommandEncoderPort {
    this.calls.push('device.createCommandEncoder');
    return new NativeEncoder(this.calls);
  }
}

class NativeAdapter implements WebGPUNativeAdapterPort {
  readonly info = { name: 'Mock WebGPU Adapter' };
  readonly features = new Set<string>();
  readonly limits = {};
  readonly formats = new Map([
    [
      'rgba8unorm',
      Object.freeze({
        sample: true,
        filter: true,
        render: true,
        blend: true,
        storage: false,
        copySrc: true,
        copyDst: true,
        sampleCounts: Object.freeze([1])
      })
    ]
  ]);
  constructor(readonly device: NativeDevice) {}
  async requestDevice(_request: WebGPUNativeDeviceRequest): Promise<WebGPUNativeDevicePort> {
    return this.device;
  }
}

async function createTestWebGPUDevice() {
  const nativeDevice = new NativeDevice();
  const adapter = new NativeAdapter(nativeDevice);
  const device = await new WebGPUAdapter(adapter).requestDevice({
    requiredFeatures: [],
    optionalFeatures: []
  });
  return { device, native: nativeDevice };
}

const COLOR_DESC: TextureDescriptor = {
  width: 16,
  height: 16,
  depthOrArrayLayers: 1,
  mipLevelCount: 1,
  sampleCount: 1,
  format: 'rgba8unorm',
  usage: ['color-attachment', 'sampled']
};

const SURFACE_DESC: TextureDescriptor = {
  width: 16,
  height: 16,
  depthOrArrayLayers: 1,
  mipLevelCount: 1,
  sampleCount: 1,
  format: 'rgba8unorm',
  usage: ['color-attachment']
};

const BUFFER_DESC: BufferDescriptor = {
  size: 256,
  usage: ['storage-write', 'storage-read', 'vertex', 'uniform']
};

function createTestRenderPipeline(
  device: Parameters<typeof createTestWebGPUDevice> extends () => Promise<{ device: infer D }>
    ? D
    : any,
  hasVertexBuffer = false
) {
  return device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [] }),
    vertex: {
      module: device.createShaderModule({ code: '@vertex fn main() {}' }),
      entryPoint: 'main',
      ...(hasVertexBuffer
        ? {
            buffers: [{ arrayStride: 16, stepMode: 'vertex', attributes: [] }]
          }
        : {})
    },
    primitive: { topology: 'triangle-list' },
    fragment: {
      module: device.createShaderModule({ code: '@fragment fn main() {}' }),
      entryPoint: 'main',
      targets: [{ format: 'rgba8unorm' }]
    }
  });
}

function createTestComputePipeline(
  device: Parameters<typeof createTestWebGPUDevice> extends () => Promise<{ device: infer D }>
    ? D
    : any
) {
  return device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [] }),
    compute: {
      module: device.createShaderModule({
        code: '@compute @workgroup_size(1) fn main() {}'
      }),
      entryPoint: 'main'
    }
  });
}

describe('WebGPU resource transitions and execution pass boundaries', () => {
  test('validates attachment write -> sampled read enforces render pass boundary and transitions', async () => {
    const { device, native } = await createTestWebGPUDevice();
    const graph = new RenderGraphBuilder();

    // Transient texture written as attachment in pass A, sampled in pass B
    const intermediate = graph.createTexture(COLOR_DESC, {
      origin: { kind: 'transient' }
    });

    const output = graph.createTexture(SURFACE_DESC, {
      origin: {
        kind: 'imported',
        initialState: 'color-attachment',
        acquire: { kind: 'external-acquire', id: 'frame' }
      }
    });

    // Pass 1: writes to intermediate color attachment
    let writtenHdr = intermediate;
    graph.addRasterPass({
      id: 'generate-hdr',
      setup(pass) {
        writtenHdr = pass.colorAttachment(0, intermediate, {
          load: 'clear',
          store: 'store',
          range: {
            baseMipLevel: 0,
            mipLevelCount: 1,
            baseArrayLayer: 0,
            arrayLayerCount: 1,
            aspect: 'all'
          }
        });
        return {};
      },
      run(ctx) {
        const pipeline = createTestRenderPipeline(ctx.device);
        ctx.raster.setPipeline(pipeline);
        ctx.raster.draw(3);
      }
    });

    // Pass 2: samples intermediate texture and writes to output
    graph.addRasterPass({
      id: 'composite-output',
      setup(pass) {
        pass.readTexture(writtenHdr, 'sampled');
        const writtenOutput = pass.colorAttachment(0, output, {
          load: 'clear',
          store: 'store',
          range: {
            baseMipLevel: 0,
            mipLevelCount: 1,
            baseArrayLayer: 0,
            arrayLayerCount: 1,
            aspect: 'all'
          }
        });
        pass.present(writtenOutput, { kind: 'surface-frame', id: 'frame' });
        return {};
      },
      run(ctx) {
        const pipeline = createTestRenderPipeline(ctx.device);
        ctx.raster.setPipeline(pipeline);
        ctx.texture(writtenHdr, 'sampled');
        ctx.raster.draw(3);
      }
    });

    const snapshot = graph.build();
    const compiled = compileRenderGraph(snapshot);
    const plan = createRenderGraphExecutionPlan(snapshot, compiled);

    // 1. Fusion verification: the two passes cannot be fused because of attachment -> sampled hazard
    expect(plan.rasterGroups.length).toBe(2);
    expect(plan.rasterGroups[0]!.retainedPassIndices).toEqual([0]);
    expect(plan.rasterGroups[1]!.retainedPassIndices).toEqual([1]);

    // 2. Transition verification: intermediate texture transitions from color-attachment to sampled across passes
    const intermediateResId = intermediate.resourceId;
    const transition = plan.transitions.find(
      (t) => t.resourceId === intermediateResId && t.fromPassId !== null
    );
    expect(transition).toBeDefined();
    expect(transition!.beforeUsage).toBe('color-attachment');
    expect(transition!.afterUsage).toBe('sampled');
    expect(transition!.fromPassId).toBe(snapshot.passes[0]!.token.passId);
    expect(transition!.toPassId).toBe(snapshot.passes[1]!.token.passId);

    // 3. Execution on WebGPU: verify physical render pass boundaries
    const surfaceTexture = device.createTexture({
      size: { width: 16, height: 16 },
      format: 'rgba8unorm',
      usage: 16
    });

    let presented = false;
    const mockSurface = {
      acquire: () => ({
        status: 'success' as const,
        frame: {
          texture: surfaceTexture,
          id: 'frame',
          present: () => {
            presented = true;
          },
          release: () => undefined
        }
      })
    };

    const executor = new RenderGraphExecutor();
    executor.execute(plan, {
      device,
      surface: mockSurface as unknown as RHISurface
    });

    expect(presented).toBe(true);

    // Verify native call trace: Pass 1 begins and ends, then Pass 2 begins and ends
    const passTrace = native.calls.filter(
      (call) =>
        call === 'encoder.beginRenderPass' ||
        call === 'render.setPipeline' ||
        call === 'render.draw' ||
        call === 'render.end' ||
        call === 'encoder.finish' ||
        call === 'queue.submit'
    );

    expect(passTrace).toEqual([
      'encoder.beginRenderPass',
      'render.setPipeline',
      'render.draw',
      'render.end',
      'encoder.beginRenderPass',
      'render.setPipeline',
      'render.draw',
      'render.end',
      'encoder.finish',
      'queue.submit'
    ]);
  });

  test('validates compute write -> vertex buffer read enforces compute pass end before render pass', async () => {
    const { device, native } = await createTestWebGPUDevice();
    const graph = new RenderGraphBuilder();

    // Transient buffer written in compute, read as vertex in raster
    const vertexBuffer = graph.createBuffer(BUFFER_DESC, {
      origin: { kind: 'transient' }
    });

    const output = graph.createTexture(SURFACE_DESC, {
      origin: {
        kind: 'imported',
        initialState: 'color-attachment',
        acquire: { kind: 'external-acquire', id: 'frame' }
      }
    });

    // Pass 1: Compute generates vertex data
    let writtenVerts = vertexBuffer;
    graph.addComputePass({
      id: 'compute-vertices',
      setup(pass) {
        writtenVerts = pass.writeBuffer(vertexBuffer, 'storage-write');
        return {};
      },
      run(ctx) {
        const pipeline = createTestComputePipeline(ctx.device);
        ctx.compute.setPipeline(pipeline);
        ctx.compute.dispatchWorkgroups(1);
      }
    });

    // Pass 2: Raster draws with the vertex buffer
    graph.addRasterPass({
      id: 'draw-vertices',
      setup(pass) {
        pass.readBuffer(writtenVerts, 'vertex');
        const writtenOutput = pass.colorAttachment(0, output, {
          load: 'clear',
          store: 'store',
          range: {
            baseMipLevel: 0,
            mipLevelCount: 1,
            baseArrayLayer: 0,
            arrayLayerCount: 1,
            aspect: 'all'
          }
        });
        pass.present(writtenOutput, { kind: 'surface-frame', id: 'frame' });
        return {};
      },
      run(ctx) {
        const pipeline = createTestRenderPipeline(ctx.device, true);
        ctx.raster.setPipeline(pipeline);
        const slice = ctx.buffer(writtenVerts, 'vertex');
        ctx.raster.setVertexBuffer(0, slice);
        ctx.raster.draw(3);
      }
    });

    const snapshot = graph.build();
    const compiled = compileRenderGraph(snapshot);
    const plan = createRenderGraphExecutionPlan(snapshot, compiled);

    // 1. Schedule verification: compute pass followed by raster group
    expect(plan.schedule[1]!.kind).toBe('pass');
    expect((plan.schedule[1] as { kind: 'pass'; passId: number }).passId).toBe(
      snapshot.passes[0]!.token.passId
    );
    expect(plan.schedule[2]!.kind).toBe('raster-group');

    // 2. Transition verification: buffer transitions from storage-write to vertex across passes
    const bufferResId = vertexBuffer.resourceId;
    const transition = plan.transitions.find(
      (t) => t.resourceId === bufferResId && t.fromPassId !== null
    );
    expect(transition).toBeDefined();
    expect(transition!.beforeUsage).toBe('storage-write');
    expect(transition!.afterUsage).toBe('vertex');
    expect(transition!.fromPassId).toBe(snapshot.passes[0]!.token.passId);
    expect(transition!.toPassId).toBe(snapshot.passes[1]!.token.passId);

    // 3. Execution on WebGPU: compute pass ends before render pass begins
    const surfaceTexture = device.createTexture({
      size: { width: 16, height: 16 },
      format: 'rgba8unorm',
      usage: 16
    });

    const mockSurface = {
      acquire: () => ({
        status: 'success' as const,
        frame: {
          texture: surfaceTexture,
          id: 'frame',
          present: () => undefined,
          release: () => undefined
        }
      })
    };

    const executor = new RenderGraphExecutor();
    executor.execute(plan, {
      device,
      surface: mockSurface as unknown as RHISurface
    });

    // Verify native call trace: Compute begins and ends, then Render begins, binds vertex buffer, and ends
    const passTrace = native.calls.filter(
      (call) =>
        call === 'encoder.beginComputePass' ||
        call === 'compute.setPipeline' ||
        call === 'compute.dispatchWorkgroups' ||
        call === 'compute.end' ||
        call === 'encoder.beginRenderPass' ||
        call === 'render.setPipeline' ||
        call === 'render.setVertexBuffer' ||
        call === 'render.draw' ||
        call === 'render.end' ||
        call === 'encoder.finish' ||
        call === 'queue.submit'
    );

    expect(passTrace).toEqual([
      'encoder.beginComputePass',
      'compute.setPipeline',
      'compute.dispatchWorkgroups',
      'compute.end',
      'encoder.beginRenderPass',
      'render.setPipeline',
      'render.setVertexBuffer',
      'render.draw',
      'render.end',
      'encoder.finish',
      'queue.submit'
    ]);
  });

  test('validates compute write -> subsequent compute read creates sequential compute passes', async () => {
    const { device, native } = await createTestWebGPUDevice();
    const graph = new RenderGraphBuilder();

    const dataBuffer = graph.createBuffer(BUFFER_DESC, {
      origin: { kind: 'transient' }
    });

    let writtenData = dataBuffer;
    graph.addComputePass({
      id: 'compute-pass-1',
      setup(pass) {
        writtenData = pass.writeBuffer(dataBuffer, 'storage-write');
        pass.sideEffect('compute write');
        return {};
      },
      run(ctx) {
        const pipeline = createTestComputePipeline(ctx.device);
        ctx.compute.setPipeline(pipeline);
        ctx.compute.dispatchWorkgroups(2);
      }
    });

    graph.addComputePass({
      id: 'compute-pass-2',
      setup(pass) {
        pass.readBuffer(writtenData, 'storage-read');
        pass.sideEffect('compute read');
        return {};
      },
      run(ctx) {
        const pipeline = createTestComputePipeline(ctx.device);
        ctx.compute.setPipeline(pipeline);
        ctx.compute.dispatchWorkgroups(2);
      }
    });

    const snapshot = graph.build();
    const compiled = compileRenderGraph(snapshot);
    const plan = createRenderGraphExecutionPlan(snapshot, compiled);

    // Verify transition from storage-write to storage-read
    const bufferResId = dataBuffer.resourceId;
    const transition = plan.transitions.find(
      (t) => t.resourceId === bufferResId && t.fromPassId !== null
    );
    expect(transition).toBeDefined();
    expect(transition!.beforeUsage).toBe('storage-write');
    expect(transition!.afterUsage).toBe('storage-read');

    const executor = new RenderGraphExecutor();
    executor.execute(plan, { device });

    const passTrace = native.calls.filter(
      (call) =>
        call === 'encoder.beginComputePass' ||
        call === 'compute.setPipeline' ||
        call === 'compute.dispatchWorkgroups' ||
        call === 'compute.end'
    );

    expect(passTrace).toEqual([
      'encoder.beginComputePass',
      'compute.setPipeline',
      'compute.dispatchWorkgroups',
      'compute.end',
      'encoder.beginComputePass',
      'compute.setPipeline',
      'compute.dispatchWorkgroups',
      'compute.end'
    ]);
  });

  test('rejects distinct imported resources bound to the same physical storage', async () => {
    const { device } = await createTestWebGPUDevice();
    const graph = new RenderGraphBuilder();

    const UNIFORM_DESC: BufferDescriptor = {
      size: 256,
      usage: ['uniform']
    };

    const import1 = graph.createBuffer(UNIFORM_DESC, {
      origin: {
        kind: 'imported',
        initialState: 'uniform',
        acquire: { kind: 'external-acquire', id: 'imp-1' }
      }
    });

    const import2 = graph.createBuffer(UNIFORM_DESC, {
      origin: {
        kind: 'imported',
        initialState: 'uniform',
        acquire: { kind: 'external-acquire', id: 'imp-2' }
      }
    });

    graph.addCopyPass({
      id: 'copy-pass',
      setup(pass) {
        pass.readBuffer(import1, 'uniform');
        pass.readBuffer(import2, 'uniform');
        pass.sideEffect('copy check');
        return {};
      },
      run() {}
    });

    const snapshot = graph.build();
    const compiled = compileRenderGraph(snapshot);
    const plan = createRenderGraphExecutionPlan(snapshot, compiled);

    // Share the same physical buffer instance between import1 and import2
    const sharedPhysicalBuffer = device.createBuffer({
      size: 256,
      usage: 1 << 6 // uniform
    });

    const executor = new RenderGraphExecutor();
    expect(() =>
      executor.execute(plan, {
        device,
        resources: new Map([
          [import1, sharedPhysicalBuffer],
          [import2, sharedPhysicalBuffer]
        ])
      })
    ).toThrow(/imported resources .* cannot share physical identity/i);
  });
});
