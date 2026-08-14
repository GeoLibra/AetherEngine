import { describe, expect, test } from 'vitest';

import { WebGL2Adapter, type WebGL2NativeContextLostInfo } from '../../../src';

interface NativeObject {
  readonly kind: string;
  readonly id: number;
}

class FramebufferContext {
  readonly info = { name: 'Framebuffer WebGL2' };
  readonly extensions = new Set<string>();
  readonly limits = {};
  readonly formats = new Map();
  readonly precision = {};
  readonly lost = new Promise<WebGL2NativeContextLostInfo>(() => {});
  readonly calls: Array<{ name: string; args: readonly unknown[] }> = [];
  complete = true;
  private nextId = 1;

  createTexture(): NativeObject {
    return this.object('texture');
  }
  createFramebuffer(...args: unknown[]): NativeObject {
    this.call('createFramebuffer', args);
    return this.object('framebuffer');
  }
  checkFramebufferStatus(...args: unknown[]) {
    this.call('checkFramebufferStatus', args);
    return { complete: this.complete, status: this.complete ? 'complete' : 'missing-attachment' };
  }
  deleteFramebuffer(...args: unknown[]): void {
    this.call('deleteFramebuffer', args);
  }
  deleteTexture(...args: unknown[]): void {
    this.call('deleteTexture', args);
  }
  bindFramebuffer(...args: unknown[]): void {
    this.call('bindFramebuffer', args);
  }
  beginRenderPass(...args: unknown[]): void {
    this.call('beginRenderPass', args);
  }
  applyRenderPassLoadOperations(...args: unknown[]): void {
    this.call('applyRenderPassLoadOperations', args);
  }
  applyRenderPassStoreOperations(...args: unknown[]): void {
    this.call('applyRenderPassStoreOperations', args);
  }
  resolveRenderPass(...args: unknown[]): void {
    this.call('resolveRenderPass', args);
  }
  endRenderPass(...args: unknown[]): void {
    this.call('endRenderPass', args);
  }

  private object(kind: string): NativeObject {
    return { kind, id: this.nextId++ };
  }
  private call(name: string, args: readonly unknown[]): void {
    this.calls.push({ name, args });
  }
}

async function createDevice(native = new FramebufferContext()) {
  const device = await new WebGL2Adapter(native).requestDevice({
    requiredFeatures: [],
    optionalFeatures: []
  });
  return { device, native };
}

describe('WebGL2 framebuffer cache', () => {
  test('reuses attachment identity while applying pass operations every time', async () => {
    const { device, native } = await createDevice();
    const texture = device.createTexture({
      label: 'color',
      size: [8, 8],
      format: 'rgba8unorm',
      usage: 16
    });
    const view = texture.createView();
    const encoder = device.createCommandEncoder();
    const first = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          loadOp: 'clear',
          storeOp: 'discard',
          clearValue: [1, 0, 0, 1]
        }
      ]
    });
    first.end();
    const second = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }]
    });
    second.end();
    native.calls.length = 0;

    const submission = device.queue.submit([encoder.finish()]);
    await submission.done;
    const names = native.calls.map((call) => call.name);

    expect(names.filter((name) => name === 'createFramebuffer')).toHaveLength(1);
    expect(names.filter((name) => name === 'checkFramebufferStatus')).toHaveLength(1);
    expect(names.filter((name) => name === 'bindFramebuffer')).toHaveLength(1);
    expect(names.filter((name) => name === 'applyRenderPassLoadOperations')).toHaveLength(2);
    expect(names.filter((name) => name === 'applyRenderPassStoreOperations')).toHaveLength(2);
    expect(device.queue.metrics()).toMatchObject({
      framebufferCacheHits: 1,
      framebufferCacheMisses: 1
    });
  });

  test('misses for different subresources and resolve configuration', async () => {
    const { device, native } = await createDevice();
    const texture = device.createTexture({
      size: [8, 8],
      mipLevelCount: 2,
      format: 'rgba8unorm',
      usage: 16
    });
    const resolve = device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: 16 });
    const encoder = device.createCommandEncoder();
    const descriptors = [
      {
        view: texture.createView({ baseMipLevel: 0 }),
        loadOp: 'load' as const,
        storeOp: 'store' as const
      },
      {
        view: texture.createView({ baseMipLevel: 1 }),
        loadOp: 'load' as const,
        storeOp: 'store' as const
      },
      {
        view: texture.createView({ baseMipLevel: 0 }),
        resolveTarget: resolve.createView(),
        loadOp: 'load' as const,
        storeOp: 'store' as const
      }
    ];
    for (const attachment of descriptors) {
      const pass = encoder.beginRenderPass({ colorAttachments: [attachment] });
      pass.end();
    }
    native.calls.length = 0;

    await device.queue.submit([encoder.finish()]).done;

    expect(native.calls.filter((call) => call.name === 'createFramebuffer')).toHaveLength(3);
    expect(native.calls.filter((call) => call.name === 'resolveRenderPass')).toHaveLength(1);
    const loweredDescriptors = native.calls
      .filter((call) => call.name === 'createFramebuffer')
      .map((call) => call.args[0] as { colorAttachments: Array<Record<string, unknown>> });
    expect(loweredDescriptors[0]?.colorAttachments[0]).toMatchObject({
      mipLevel: 0,
      width: 8,
      height: 8
    });
    expect(loweredDescriptors[1]?.colorAttachments[0]).toMatchObject({
      mipLevel: 1,
      width: 4,
      height: 4
    });
    expect(loweredDescriptors[2]?.colorAttachments[0]).toMatchObject({
      resolveTargetMipLevel: 0,
      resolveTargetWidth: 8,
      resolveTargetHeight: 8
    });
  });

  test('reports incomplete attachments and evicts on logical dispose', async () => {
    const { device, native } = await createDevice();
    const texture = device.createTexture({
      label: 'broken-color',
      size: [4, 4],
      format: 'rgba8unorm',
      usage: 16
    });
    const view = texture.createView({ label: 'broken-view' });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }]
    });
    pass.end();
    native.complete = false;
    native.calls.length = 0;

    const result = await device.queue.submit([encoder.finish()]).done;

    expect(result).toEqual({ status: 'failed', error: expect.any(Error) });
    expect(String(result.error)).toContain('broken-view');
    expect(String(result.error)).toContain('rgba8unorm');
    expect(native.calls.filter((call) => call.name === 'deleteFramebuffer')).toHaveLength(1);

    native.complete = true;
    const retryEncoder = device.createCommandEncoder();
    const retry = retryEncoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }]
    });
    retry.end();
    await device.queue.submit([retryEncoder.finish()]).done;
    view.dispose();
    expect(native.calls.filter((call) => call.name === 'deleteFramebuffer')).toHaveLength(2);
  });
});
