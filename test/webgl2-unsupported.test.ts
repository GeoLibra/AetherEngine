import { describe, expect, test } from 'vitest';

import {
  RHIUnsupportedOperationError,
  WebGL2Adapter,
  type WebGL2NativeContextLostInfo
} from '../src';

class NativeContext {
  readonly info = { name: 'Unsupported WebGL2' };
  readonly extensions = new Set<string>();
  readonly limits = {};
  readonly formats = new Map();
  readonly precision = {};
  readonly lost = new Promise<WebGL2NativeContextLostInfo>(() => {});
  created = 0;
  createBuffer(): object { this.created += 1; return {}; }
  createTexture(): object { this.created += 1; return {}; }
}

async function createDevice() {
  const native = new NativeContext();
  const device = await new WebGL2Adapter(native).requestDevice({ requiredFeatures: [], optionalFeatures: [] });
  return { device, native };
}

function expectUnsupported(action: () => unknown, operation: string, feature: string): void {
  try {
    action();
    throw new Error('Expected unsupported operation.');
  } catch (error) {
    expect(error).toBeInstanceOf(RHIUnsupportedOperationError);
    expect(error).toMatchObject({
      operation,
      required: [{ kind: 'feature', feature }],
      actual: { backend: 'webgl2' }
    });
  }
}

describe('WebGL2 typed unsupported boundaries', () => {
  test('rejects compute pipeline creation without returning a fake pipeline', async () => {
    const { device } = await createDevice();
    expectUnsupported(() => device.createComputePipeline(), 'create-compute-pipeline', 'compute');
  });

  test('rejects storage resource usages before native creation', async () => {
    const { device, native } = await createDevice();
    expectUnsupported(
      () => device.createBuffer({ size: 16, usage: 1 << 7 }),
      'create-storage-buffer', 'storage-buffer'
    );
    expectUnsupported(
      () => device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 1 << 3 }),
      'create-storage-texture', 'storage-texture'
    );
    expect(native.created).toBe(0);
  });

  test('rejects storage layouts at layout creation', async () => {
    const { device } = await createDevice();
    expectUnsupported(() => device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: 1, buffer: { type: 'storage' } }]
    }), 'create-storage-buffer', 'storage-buffer');
    expectUnsupported(() => device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: 1, storageTexture: { access: 'write-only', format: 'rgba8unorm' } }]
    }), 'create-storage-texture', 'storage-texture');
  });
});
