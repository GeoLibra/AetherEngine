import { describe, expect, test } from 'vitest';

import {
  WebGL2Adapter,
  WebGL2ContextControlExtension,
  type WebGL2NativeContextLostInfo
} from '../../../src';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface NativeObject {
  readonly kind: string;
  readonly id: number;
}

class ContextLossPort {
  readonly info = { name: 'Context loss WebGL2' };
  readonly extensions = new Set<string>();
  readonly limits = { maxUniformBufferBindings: 4, maxTextureUnits: 4 };
  readonly formats = new Map();
  readonly precision = {};
  readonly calls: string[] = [];
  readonly fences: Deferred<void>[] = [];
  private readonly loss = deferred<WebGL2NativeContextLostInfo>();
  readonly lost = this.loss.promise;
  private nextId = 1;

  lose(info: WebGL2NativeContextLostInfo): void {
    this.loss.resolve(info);
  }
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
    this.calls.push('createFramebuffer');
    return this.object('framebuffer');
  }
  checkFramebufferStatus(): { complete: true } {
    return { complete: true };
  }
  createVertexArray(): NativeObject {
    this.calls.push('createVertexArray');
    return this.object('vertex-array');
  }
  createSubmissionFence(): Promise<void> {
    const fence = deferred<void>();
    this.fences.push(fence);
    return fence.promise;
  }
  useProgram(): void {
    this.calls.push('useProgram');
  }
  setRasterState(): void {
    this.calls.push('setRasterState');
  }
  setDepthStencilState(): void {
    this.calls.push('setDepthStencilState');
  }
  bindFramebuffer(): void {
    this.calls.push('bindFramebuffer');
  }
  bindVertexArray(): void {
    this.calls.push('bindVertexArray');
  }
  bindVertexBuffer(): void {
    this.calls.push('bindVertexBuffer');
  }
  beginRenderPass(): void {}
  endRenderPass(): void {}
  draw(): void {}
  deleteBuffer(): void {
    this.calls.push('deleteBuffer');
  }
  deleteTexture(): void {
    this.calls.push('deleteTexture');
  }
  deleteProgram(): void {
    this.calls.push('deleteProgram');
  }
  deleteFramebuffer(): void {
    this.calls.push('deleteFramebuffer');
  }
  deleteVertexArray(): void {
    this.calls.push('deleteVertexArray');
  }

  private object(kind: string): NativeObject {
    return { kind, id: this.nextId++ };
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
      requiredExtensions: [],
      sourceMap: [],
      translatorFingerprint: 'test-output'
    };
  }
}

async function createFixture(native = new ContextLossPort()) {
  const Adapter = WebGL2Adapter as unknown as new (
    context: ContextLossPort,
    translator: Translator
  ) => WebGL2Adapter;
  const device = await new Adapter(native, new Translator()).requestDevice({
    requiredFeatures: [],
    optionalFeatures: []
  });
  const shader = device.createShaderModule({ code: 'shader-ir' });
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
  const texture = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 16 });
  const view = texture.createView();
  const vertex = device.createBuffer({ size: 64, usage: 32 });
  return { device, native, pipeline, texture, view, vertex };
}

function recordDraw(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const encoder = fixture.device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: fixture.view, loadOp: 'load', storeOp: 'store' }]
  });
  pass.setPipeline(fixture.pipeline);
  pass.setVertexBuffer(0, fixture.vertex);
  pass.draw(3);
  pass.end();
  return encoder.finish();
}

async function complete(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<void> {
  const submission = fixture.device.queue.submit([recordDraw(fixture)]);
  fixture.native.fences.at(-1)?.resolve(undefined);
  await submission.done;
}

describe('WebGL2 context control', () => {
  test('invalidates proven state without exposing raw context or submission', async () => {
    const fixture = await createFixture();
    await complete(fixture);
    await complete(fixture);
    expect(fixture.native.calls.filter((call) => call === 'useProgram')).toHaveLength(1);
    expect(fixture.native.calls.filter((call) => call === 'createFramebuffer')).toHaveLength(1);

    const control = fixture.device.getExtension(WebGL2ContextControlExtension);
    expect(control).toBeDefined();
    expect(Object.keys(control ?? {})).toEqual(['invalidateExternalState']);
    expect('context' in (control ?? {})).toBe(false);
    expect('submit' in (control ?? {})).toBe(false);
    control?.invalidateExternalState();
    await complete(fixture);

    expect(fixture.native.calls.filter((call) => call === 'useProgram')).toHaveLength(2);
    expect(fixture.native.calls.filter((call) => call === 'bindFramebuffer')).toHaveLength(2);
    expect(fixture.native.calls.filter((call) => call === 'bindVertexArray')).toHaveLength(2);
    expect(fixture.native.calls.filter((call) => call === 'createFramebuffer')).toHaveLength(1);
    expect(fixture.native.calls.filter((call) => call === 'createVertexArray')).toHaveLength(1);
  });

  test('settles loss once, abandons stale handles, and requires a new generation', async () => {
    const fixture = await createFixture();
    await complete(fixture);
    fixture.native.calls.length = 0;
    const pending = fixture.device.queue.submit([recordDraw(fixture)]);

    fixture.native.lose({ reason: 'context-lost', message: 'browser reset' });

    await expect(fixture.device.lost).resolves.toEqual({
      reason: 'context-lost',
      message: 'browser reset',
      generation: fixture.device.generation
    });
    await expect(pending.done).resolves.toEqual({ status: 'device-lost' });
    expect(fixture.device.state).toBe('lost');
    expect(fixture.device.queue.metrics()).toMatchObject({
      contextLosses: 1,
      deviceLost: 1,
      pending: 0
    });
    fixture.native.fences.at(-1)?.resolve(undefined);
    await Promise.resolve();
    expect(fixture.device.queue.metrics()).toMatchObject({
      contextLosses: 1,
      completed: 1,
      deviceLost: 1
    });
    expect(fixture.vertex.state).toBe('device-lost');
    expect(fixture.view.state).toBe('device-lost');
    expect(() => fixture.device.queue.writeBuffer(fixture.vertex, 0, new Uint8Array([1]))).toThrow(
      'lost device'
    );

    fixture.view.dispose();
    fixture.vertex.dispose();
    fixture.texture.dispose();
    fixture.pipeline.dispose();
    expect(fixture.native.calls.filter((call) => call.startsWith('delete'))).toEqual([]);
    expect(() => fixture.device.createBuffer({ size: 4, usage: 1 })).toThrow('lost');
    expect(() => fixture.device.queue.submit([])).toThrow('lost device');
    expect(() =>
      fixture.device.getExtension(WebGL2ContextControlExtension)?.invalidateExternalState()
    ).toThrow('lost');

    const recovered = await createFixture(new ContextLossPort());
    expect(recovered.device.state).toBe('live');
    expect(recovered.device.generation).toBeGreaterThan(fixture.device.generation);
  });

  test('does not report explicit device destruction as a context loss', async () => {
    const fixture = await createFixture();

    fixture.device.destroy();

    await expect(fixture.device.lost).resolves.toMatchObject({ reason: 'destroyed' });
    expect(fixture.device.queue.metrics()).toMatchObject({ contextLosses: 0 });
  });
});
