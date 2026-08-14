import { describe, expect, test } from 'vitest';

import { WebGL2Adapter, type WebGL2NativeContextLostInfo } from '../../../src';

interface NativeObject {
  readonly kind: string;
  readonly id: number;
}

class VertexArrayContext {
  readonly info = { name: 'VertexArray WebGL2' };
  readonly extensions = new Set<string>();
  readonly limits = { maxUniformBufferBindings: 4, maxTextureUnits: 4 };
  readonly formats = new Map();
  readonly precision = {};
  readonly lost = new Promise<WebGL2NativeContextLostInfo>(() => {});
  readonly calls: Array<{ name: string; args: readonly unknown[] }> = [];
  private nextId = 1;

  createBuffer(): NativeObject {
    return this.object('buffer');
  }
  createTexture(): NativeObject {
    return this.object('texture');
  }
  createProgram(): NativeObject {
    return this.object('program');
  }
  getProgramReflection(): readonly [] {
    return [];
  }
  createFramebuffer(): NativeObject {
    return this.object('framebuffer');
  }
  checkFramebufferStatus(): { complete: true } {
    return { complete: true };
  }
  createVertexArray(...args: unknown[]): NativeObject {
    this.call('createVertexArray', args);
    return this.object('vertex-array');
  }
  deleteVertexArray(...args: unknown[]): void {
    this.call('deleteVertexArray', args);
  }
  bindVertexArray(...args: unknown[]): void {
    this.call('bindVertexArray', args);
  }
  bindFramebuffer(): void {}
  beginRenderPass(): void {}
  applyRenderPassLoadOperations(): void {}
  applyRenderPassStoreOperations(): void {}
  endRenderPass(): void {}
  useProgram(): void {}
  setRasterState(): void {}
  setDepthStencilState(): void {}
  bindVertexBuffer(): void {}
  bindIndexBuffer(): void {}
  draw(): void {}

  private object(kind: string): NativeObject {
    return { kind, id: this.nextId++ };
  }
  private call(name: string, args: readonly unknown[]): void {
    this.calls.push({ name, args });
  }
}

class Translator {
  readonly translatorId = 'test';
  readonly version = 1;
  translate(input: { entryPoint: string }) {
    return {
      source: `void ${input.entryPoint}() {}`,
      bindings: [],
      targetAbiFingerprint: 'test-abi',
      physicalBindings: [],
      programBindings: [],
      requiredExtensions: [],
      sourceMap: [],
      translatorFingerprint: 'test-output'
    };
  }
}

async function createFixture() {
  const native = new VertexArrayContext();
  const Adapter = WebGL2Adapter as unknown as new (
    native: VertexArrayContext,
    translator: Translator
  ) => WebGL2Adapter;
  const device = await new Adapter(native, new Translator()).requestDevice({
    requiredFeatures: [],
    optionalFeatures: []
  });
  const shader = device.createShaderModule({ code: 'vertex-ir' });
  const pipeline = device.createRenderPipeline({
    vertex: {
      module: shader,
      buffers: [
        {
          arrayStride: 16,
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }]
        }
      ]
    },
    fragment: { module: shader, targets: [{ format: 'rgba8unorm' }] }
  });
  const color = device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: 16 });
  const vertex = device.createBuffer({ size: 128, usage: 32 });
  const index = device.createBuffer({ size: 64, usage: 16 });
  return { device, native, pipeline, color, vertex, index };
}

function recordDraws(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  offsets: readonly number[]
) {
  const { device, pipeline, color, vertex, index } = fixture;
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: color.createView(), loadOp: 'load', storeOp: 'store' }]
  });
  pass.setPipeline(pipeline);
  pass.setIndexBuffer(index, 'uint16');
  for (const offset of offsets) {
    pass.setVertexBuffer(0, vertex, offset, 64);
    pass.draw(3);
  }
  pass.end();
  return encoder.finish();
}

describe('WebGL2 vertex array cache', () => {
  test('hits for identical vertex state and misses when offset changes', async () => {
    const fixture = await createFixture();
    fixture.native.calls.length = 0;

    await fixture.device.queue.submit([recordDraws(fixture, [0, 0, 16])]).done;

    expect(fixture.native.calls.filter((call) => call.name === 'createVertexArray')).toHaveLength(
      2
    );
    expect(fixture.native.calls.filter((call) => call.name === 'bindVertexArray')).toHaveLength(2);
    expect(fixture.device.queue.metrics()).toMatchObject({
      vertexArrayCacheHits: 1,
      vertexArrayCacheMisses: 2
    });
  });

  test('includes index identity and evicts entries when a buffer is disposed', async () => {
    const fixture = await createFixture();
    await fixture.device.queue.submit([recordDraws(fixture, [0])]).done;
    fixture.native.calls.length = 0;

    fixture.vertex.dispose();

    expect(fixture.native.calls.filter((call) => call.name === 'deleteVertexArray')).toHaveLength(
      1
    );
  });
});
