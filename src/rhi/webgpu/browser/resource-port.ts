import type {
  WebGPUNativeBufferPort,
  WebGPUNativeResourcePort,
  WebGPUNativeTexturePort
} from '../types';

export interface BrowserWebGPUDeviceOwner {
  readonly token: symbol;
  readonly generation: number;
}

const nativeResources = new WeakMap<object, object>();

export class BrowserWebGPUResourcePort implements WebGPUNativeResourcePort {
  constructor(
    readonly owner: BrowserWebGPUDeviceOwner,
    native: object
  ) {
    nativeResources.set(this, native);
  }

  destroy(): void {
    const native = unwrapBrowserWebGPUResource(this, this.owner);
    callOptional(native, 'destroy');
  }
}

export class BrowserWebGPUBufferPort
  extends BrowserWebGPUResourcePort
  implements WebGPUNativeBufferPort
{
  readonly size: number;
  readonly usage: number;

  constructor(owner: BrowserWebGPUDeviceOwner, native: object, size: number, usage: number) {
    super(owner, native);
    this.size = size;
    this.usage = usage;
  }

  async mapAsync(mode: number, offset: number, size: number): Promise<void> {
    const native = unwrapBrowserWebGPUResource(this, this.owner);
    await callRequired(native, 'mapAsync', [mode, offset, size]);
  }

  getMappedRange(offset: number, size: number): ArrayBuffer {
    const native = unwrapBrowserWebGPUResource(this, this.owner);
    const result = callRequired(native, 'getMappedRange', [offset, size]);
    if (!(result instanceof ArrayBuffer))
      throw new TypeError('GPUBuffer.getMappedRange() did not return an ArrayBuffer.');
    return result;
  }

  unmap(): void {
    callRequired(unwrapBrowserWebGPUResource(this, this.owner), 'unmap', []);
  }
}

export class BrowserWebGPUTexturePort
  extends BrowserWebGPUResourcePort
  implements WebGPUNativeTexturePort
{
  createView(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort {
    const native = unwrapBrowserWebGPUResource(this, this.owner);
    const view = callRequired(native, 'createView', [descriptor]);
    return new BrowserWebGPUResourcePort(
      this.owner,
      requireObject(view, 'GPUTexture.createView()')
    );
  }
}

export function unwrapBrowserWebGPUResource(
  resource: unknown,
  owner: BrowserWebGPUDeviceOwner
): object {
  if (!(resource instanceof BrowserWebGPUResourcePort))
    return requireObject(resource, 'WebGPU resource');
  if (resource.owner !== owner || resource.owner.generation !== owner.generation) {
    throw new Error('Browser WebGPU resource belongs to a different device generation.');
  }
  const native = nativeResources.get(resource);
  if (native === undefined) throw new Error('Browser WebGPU resource has no native handle.');
  return native;
}

function callOptional(target: object, key: string): void {
  const method = Reflect.get(target, key);
  if (typeof method === 'function') Reflect.apply(method, target, []);
}

function callRequired(target: object, key: string, args: readonly unknown[]): unknown {
  const method = Reflect.get(target, key);
  if (typeof method !== 'function')
    throw new TypeError(`Native WebGPU object does not implement ${key}().`);
  return Reflect.apply(method, target, args);
}

function requireObject(value: unknown, label: string): object {
  if (typeof value !== 'object' || value === null)
    throw new TypeError(`${label} is not an object.`);
  return value;
}
