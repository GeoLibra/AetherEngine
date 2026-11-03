import type { FormatCapabilities, RHILimits } from '../../contracts/capability';
import type { GPUTextureFormat } from '../../contracts/webgpu';
import type { WebGPUNativeAdapterPort, WebGPUNativeDeviceRequest } from '../types';
import { lowerBrowserDeviceRequest } from './device-port';
import type { BrowserWebGPUAdapterRequestOptions, BrowserWebGPUEnvironment } from './types';

const BROWSER_WEBGPU_FORMATS: readonly GPUTextureFormat[] = Object.freeze([
  'r8unorm',
  'rg8unorm',
  'rgba8unorm',
  'rgba8unorm-srgb',
  'bgra8unorm',
  'bgra8unorm-srgb',
  'rgba16float',
  'rgba32float',
  'rgba32uint',
  'depth24plus',
  'depth24plus-stencil8',
  'depth32float'
]);

const WEBGPU_LIMIT_NAMES = Object.freeze([
  'maxTextureDimension1D',
  'maxTextureDimension2D',
  'maxTextureDimension3D',
  'maxTextureArrayLayers',
  'maxBindGroups',
  'maxBindGroupsPlusVertexBuffers',
  'maxBindingsPerBindGroup',
  'maxDynamicUniformBuffersPerPipelineLayout',
  'maxDynamicStorageBuffersPerPipelineLayout',
  'maxSampledTexturesPerShaderStage',
  'maxSamplersPerShaderStage',
  'maxStorageBuffersPerShaderStage',
  'maxStorageTexturesPerShaderStage',
  'maxUniformBuffersPerShaderStage',
  'maxUniformBufferBindingSize',
  'maxStorageBufferBindingSize',
  'minUniformBufferOffsetAlignment',
  'minStorageBufferOffsetAlignment',
  'maxVertexBuffers',
  'maxBufferSize',
  'maxVertexAttributes',
  'maxVertexBufferArrayStride',
  'maxInterStageShaderVariables',
  'maxColorAttachments',
  'maxColorAttachmentBytesPerSample',
  'maxComputeWorkgroupStorageSize',
  'maxComputeInvocationsPerWorkgroup',
  'maxComputeWorkgroupSizeX',
  'maxComputeWorkgroupSizeY',
  'maxComputeWorkgroupSizeZ',
  'maxComputeWorkgroupsPerDimension'
]);

export async function requestBrowserWebGPUAdapter(
  environment: BrowserWebGPUEnvironment,
  options: BrowserWebGPUAdapterRequestOptions
): Promise<WebGPUNativeAdapterPort | null> {
  const requestOptions = Object.freeze({
    ...(options.powerPreference === undefined ? {} : { powerPreference: options.powerPreference }),
    ...(options.forceFallbackAdapter === undefined
      ? {}
      : {
          forceFallbackAdapter: options.forceFallbackAdapter
        })
  });
  const nativeValue = await environment.gpu.requestAdapter(requestOptions);
  if (nativeValue === null) return null;
  const native = requireObject(nativeValue, 'GPUAdapter');
  const info = snapshotInfo(Reflect.get(native, 'info'));
  const features = snapshotStringSet(Reflect.get(native, 'features'));
  const limits = snapshotLimits(Reflect.get(native, 'limits'));

  return Object.freeze({
    info,
    features,
    limits,
    formats: createFormatCapabilities(),
    requestDevice: (request: WebGPUNativeDeviceRequest) =>
      lowerBrowserDeviceRequest(native, request)
  });
}

function snapshotInfo(value: unknown) {
  const info = requireObject(value, 'GPUAdapter.info');
  const vendor = optionalString(info, 'vendor');
  const architecture = optionalString(info, 'architecture');
  const description = optionalString(info, 'description');
  return Object.freeze({
    name: description ?? vendor ?? 'Browser WebGPU Adapter',
    ...(vendor === undefined || vendor.length === 0 ? {} : { vendor }),
    ...(architecture === undefined || architecture.length === 0 ? {} : { architecture })
  });
}

function snapshotStringSet(value: unknown): ReadonlySet<string> {
  if (
    value === null ||
    value === undefined ||
    typeof Reflect.get(value as object, Symbol.iterator) !== 'function'
  ) {
    throw new TypeError('GPUAdapter.features is not iterable.');
  }
  return new ReadonlySetSnapshot(Array.from(value as Iterable<unknown>, (entry) => String(entry)));
}

function snapshotLimits(value: unknown): RHILimits {
  const limits = requireObject(value, 'GPUAdapter.limits');
  const result: Record<string, number> = {};
  for (const key of WEBGPU_LIMIT_NAMES) {
    const entry = Reflect.get(limits, key);
    if (typeof entry === 'number' && Number.isFinite(entry)) result[key] = entry;
  }
  return Object.freeze(result);
}

function createFormatCapabilities(): ReadonlyMap<GPUTextureFormat, FormatCapabilities> {
  return new ReadonlyMapSnapshot(
    BROWSER_WEBGPU_FORMATS.map((format) => [
      format,
      Object.freeze({
        sample: true,
        filter: !format.startsWith('depth') && format !== 'rgba32uint' && format !== 'rgba32float',
        render: true,
        blend: !format.startsWith('depth') && format !== 'rgba32uint' && format !== 'rgba32float',
        storage: format === 'rgba8unorm' || format === 'rgba32uint' || format === 'rgba32float',
        copySrc: true,
        copyDst: true,
        sampleCounts: Object.freeze(
          format === 'rgba32uint' || format === 'rgba32float' ? [1] : [1, 4]
        )
      })
    ])
  );
}

/** Native browser collections are copied behind facades before the adapter port is published. */
class ReadonlySetSnapshot<T> implements ReadonlySet<T> {
  #values: Set<T>;

  constructor(values: Iterable<T>) {
    this.#values = new Set(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }
  has(value: T): boolean {
    return this.#values.has(value);
  }
  entries(): SetIterator<[T, T]> {
    return this.#values.entries();
  }
  keys(): SetIterator<T> {
    return this.#values.keys();
  }
  values(): SetIterator<T> {
    return this.#values.values();
  }
  [Symbol.iterator](): SetIterator<T> {
    return this.#values.values();
  }
  forEach(callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    this.#values.forEach((value) => callbackfn.call(thisArg, value, value, this));
  }
}

class ReadonlyMapSnapshot<K, V> implements ReadonlyMap<K, V> {
  #entries: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#entries = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#entries.size;
  }
  get(key: K): V | undefined {
    return this.#entries.get(key);
  }
  has(key: K): boolean {
    return this.#entries.has(key);
  }
  entries(): MapIterator<[K, V]> {
    return this.#entries.entries();
  }
  keys(): MapIterator<K> {
    return this.#entries.keys();
  }
  values(): MapIterator<V> {
    return this.#entries.values();
  }
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#entries.entries();
  }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.#entries.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }
}

function optionalString(record: object, key: string): string | undefined {
  const value = Reflect.get(record, key);
  return typeof value === 'string' ? value : undefined;
}

function requireObject(value: unknown, label: string): object {
  if (typeof value !== 'object' || value === null)
    throw new TypeError(`${label} is not an object.`);
  return value;
}
