import { describe, expect, test } from 'vitest';

import { WebGL2Adapter, type WebGL2NativeContextLostInfo } from '../src';

interface NativeObject { readonly id: number; readonly kind: 'buffer' | 'texture' | 'sampler' }

class ResourceContext {
  readonly info = { name: 'Resource WebGL2' };
  readonly extensions = new Set<string>();
  readonly limits = {};
  readonly formats = new Map();
  readonly precision = {};
  readonly lost = new Promise<WebGL2NativeContextLostInfo>(() => {});
  readonly created: Array<{ kind: NativeObject['kind']; descriptor: Readonly<Record<string, unknown>> }> = [];
  readonly deleted: NativeObject[] = [];
  private nextId = 1;

  createBuffer(descriptor: Readonly<Record<string, unknown>>): NativeObject {
    return this.create('buffer', descriptor);
  }
  createTexture(descriptor: Readonly<Record<string, unknown>>): NativeObject {
    return this.create('texture', descriptor);
  }
  createSampler(descriptor: Readonly<Record<string, unknown>>): NativeObject {
    return this.create('sampler', descriptor);
  }
  deleteBuffer(handle: NativeObject): void { this.deleted.push(handle); }
  deleteTexture(handle: NativeObject): void { this.deleted.push(handle); }
  deleteSampler(handle: NativeObject): void { this.deleted.push(handle); }

  private create(kind: NativeObject['kind'], descriptor: Readonly<Record<string, unknown>>): NativeObject {
    this.created.push({ kind, descriptor });
    return { id: this.nextId++, kind };
  }
}

async function createDevice(native = new ResourceContext()) {
  const device = await new WebGL2Adapter(native).requestDevice({ requiredFeatures: [], optionalFeatures: [] });
  return { device, native };
}

describe('WebGL2 resources', () => {
  test('creates resources once and snapshots portable descriptors', async () => {
    const { device, native } = await createDevice();
    const bufferDescriptor = { label: 'vertices', size: 32, usage: 1 };
    const textureDescriptor = { label: 'color', size: [8, 4] as [number, number], format: 'rgba8unorm', usage: 2 };
    const samplerDescriptor: { label: string; magFilter: 'linear' | 'nearest' } = {
      label: 'linear', magFilter: 'linear'
    };

    const buffer = device.createBuffer(bufferDescriptor);
    const texture = device.createTexture(textureDescriptor);
    const view = texture.createView({ baseMipLevel: 0 });
    const sampler = device.createSampler(samplerDescriptor);
    bufferDescriptor.size = 4;
    textureDescriptor.size[0] = 2;
    samplerDescriptor.magFilter = 'nearest';

    expect(buffer.descriptor).toMatchObject({ size: 32, usage: 1 });
    expect(texture.descriptor).toMatchObject({
      size: { width: 8, height: 4, depthOrArrayLayers: 1 }, format: 'rgba8unorm', usage: 2
    });
    expect(view.texture).toBe(texture);
    expect(sampler.descriptor.magFilter).toBe('linear');
    expect(native.created.map(({ kind }) => kind)).toEqual(['buffer', 'texture', 'sampler']);
    expect('native' in buffer || 'handle' in buffer).toBe(false);
  });

  test('deletes owned native objects exactly once but not texture views', async () => {
    const { device, native } = await createDevice();
    const buffer = device.createBuffer({ size: 16, usage: 1 });
    const texture = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 2 });
    const view = texture.createView();
    const sampler = device.createSampler();

    view.dispose();
    buffer.dispose();
    buffer.dispose();
    texture.dispose();
    sampler.dispose();

    expect(native.deleted.map(({ kind }) => kind)).toEqual(['buffer', 'texture', 'sampler']);
    expect(buffer.state).toBe('disposed');
    expect(view.state).toBe('disposed');
  });

  test('rejects mapping because WebGL2 exposes no portable mapped buffer path', async () => {
    const { device, native } = await createDevice();
    const buffer = device.createBuffer({ label: 'mapped', size: 16, usage: 1 });

    await expect(buffer.mapAsync(1)).rejects.toThrow(
      'WebGL2 buffer "mapped" does not support mapAsync.'
    );
    expect(() => buffer.getMappedRange()).toThrow(
      'WebGL2 buffer "mapped" does not expose a mapped range.'
    );
    expect(() => device.createBuffer({
      label: 'mapped-at-creation', size: 16, usage: 1, mappedAtCreation: true
    })).toThrow('WebGL2 buffer "mapped-at-creation" does not support mappedAtCreation.');
    expect(native.created).toHaveLength(1);
  });

  test('reports a missing native creation capability as unsupported by the port', async () => {
    const device = await new WebGL2Adapter({
      info: { name: 'Missing creation WebGL2' },
      extensions: new Set(),
      limits: {},
      formats: new Map(),
      precision: {},
      lost: new Promise<WebGL2NativeContextLostInfo>(() => {})
    }).requestDevice({ requiredFeatures: [], optionalFeatures: [] });

    expect(() => device.createBuffer({ size: 4, usage: 1 })).toThrow(
      'Native WebGL2 context does not support createBuffer.'
    );
  });
});
