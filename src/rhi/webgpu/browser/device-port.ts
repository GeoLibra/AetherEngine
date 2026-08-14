import type {
  WebGPUNativeDeviceLostInfo,
  WebGPUNativeDevicePort,
  WebGPUNativeDeviceRequest,
  WebGPUNativeErrorPort,
  WebGPUNativeErrorType,
  WebGPUNativeResourcePort,
  WebGPUNativeTexturePort
} from '../native-types';
import {
  lowerBrowserBufferDescriptor,
  lowerBrowserDescriptor,
  lowerBrowserDeviceDescriptor,
  lowerBrowserTextureDescriptor
} from './descriptor-lowering';
import {
  BrowserWebGPUBufferPort,
  BrowserWebGPUResourcePort,
  BrowserWebGPUTexturePort,
  unwrapBrowserWebGPUResource,
  type BrowserWebGPUDeviceOwner
} from './resource-port';
import { createBrowserWebGPUCommandEncoderPort } from './command-port';
import { createBrowserWebGPUQueuePort } from './queue-port';

let nextBrowserDeviceGeneration = 1;
const nativeDevices = new WeakMap<WebGPUNativeDevicePort, object>();
const deviceOwners = new WeakMap<WebGPUNativeDevicePort, BrowserWebGPUDeviceOwner>();

const DESCRIPTOR_KEYS = Object.freeze({
  sampler: Object.freeze([
    'label', 'addressModeU', 'addressModeV', 'addressModeW', 'magFilter', 'minFilter',
    'mipmapFilter', 'lodMinClamp', 'lodMaxClamp', 'compare', 'maxAnisotropy'
  ]),
  shaderModule: Object.freeze(['label', 'code', 'sourceMapHints', 'compilationHints']),
  bindGroupLayout: Object.freeze(['label', 'entries']),
  pipelineLayout: Object.freeze(['label', 'bindGroupLayouts']),
  bindGroup: Object.freeze(['label', 'layout', 'entries']),
  renderPipeline: Object.freeze([
    'label', 'layout', 'vertex', 'primitive', 'depthStencil', 'multisample', 'fragment'
  ]),
  computePipeline: Object.freeze(['label', 'layout', 'compute'])
});

export function createBrowserWebGPUDevicePort(
  nativeDeviceValue: unknown,
  request: WebGPUNativeDeviceRequest
): WebGPUNativeDevicePort {
  const nativeDevice = requireObject(nativeDeviceValue, 'GPUDevice');
  const owner: BrowserWebGPUDeviceOwner = Object.freeze({
    token: Symbol('BrowserWebGPUDevice'),
    generation: nextBrowserDeviceGeneration++
  });
  const nativeQueue = requireObject(Reflect.get(nativeDevice, 'queue'), 'GPUQueue');

  const port: WebGPUNativeDevicePort = {
    lost: normalizeLostPromise(Reflect.get(nativeDevice, 'lost')),
    queue: createBrowserWebGPUQueuePort(nativeQueue, owner),
    destroy(): void { callOptional(nativeDevice, 'destroy'); },
    createBuffer(descriptor): WebGPUNativeResourcePort {
      const lowered = lowerBrowserBufferDescriptor(descriptor);
      const native = requireObject(callRequired(nativeDevice, 'createBuffer', [lowered]), 'GPUBuffer');
      return new BrowserWebGPUBufferPort(
        owner,
        native,
        requireNumber(lowered, 'size'),
        requireNumber(lowered, 'usage')
      );
    },
    createTexture(descriptor): WebGPUNativeTexturePort {
      const lowered = lowerBrowserTextureDescriptor(descriptor);
      const native = requireObject(callRequired(nativeDevice, 'createTexture', [lowered]), 'GPUTexture');
      return new BrowserWebGPUTexturePort(owner, native);
    },
    createSampler(descriptor): WebGPUNativeResourcePort {
      return createResource(nativeDevice, owner, 'createSampler', descriptor, DESCRIPTOR_KEYS.sampler);
    },
    createShaderModule(descriptor): WebGPUNativeResourcePort {
      return createResource(nativeDevice, owner, 'createShaderModule', descriptor, DESCRIPTOR_KEYS.shaderModule);
    },
    createBindGroupLayout(descriptor): WebGPUNativeResourcePort {
      return createResource(nativeDevice, owner, 'createBindGroupLayout', descriptor, DESCRIPTOR_KEYS.bindGroupLayout);
    },
    createPipelineLayout(descriptor): WebGPUNativeResourcePort {
      return createResource(nativeDevice, owner, 'createPipelineLayout', descriptor, DESCRIPTOR_KEYS.pipelineLayout);
    },
    createBindGroup(descriptor): WebGPUNativeResourcePort {
      return createResource(nativeDevice, owner, 'createBindGroup', descriptor, DESCRIPTOR_KEYS.bindGroup);
    },
    createRenderPipeline(descriptor): WebGPUNativeResourcePort {
      return createResource(nativeDevice, owner, 'createRenderPipeline', descriptor, DESCRIPTOR_KEYS.renderPipeline);
    },
    createComputePipeline(descriptor): WebGPUNativeResourcePort {
      return createResource(nativeDevice, owner, 'createComputePipeline', descriptor, DESCRIPTOR_KEYS.computePipeline);
    },
    async createRenderPipelineAsync(descriptor): Promise<WebGPUNativeResourcePort> {
      return createResourceAsync(nativeDevice, owner, 'createRenderPipelineAsync', descriptor, DESCRIPTOR_KEYS.renderPipeline);
    },
    async createComputePipelineAsync(descriptor): Promise<WebGPUNativeResourcePort> {
      return createResourceAsync(nativeDevice, owner, 'createComputePipelineAsync', descriptor, DESCRIPTOR_KEYS.computePipeline);
    },
    createCommandEncoder(descriptor) {
      return createBrowserWebGPUCommandEncoderPort(nativeDevice, owner, descriptor);
    },
    pushErrorScope(filter): void { callRequired(nativeDevice, 'pushErrorScope', [filter]); },
    async popErrorScope(): Promise<WebGPUNativeErrorPort | null> {
      const error = await callRequired(nativeDevice, 'popErrorScope', []);
      return error === null ? null : normalizeNativeError(error);
    },
    setUncapturedErrorHandler(handler): () => void {
      const listener = (event: unknown): void => {
        const eventObject = requireObject(event, 'GPUUncapturedErrorEvent');
        handler(normalizeNativeError(Reflect.get(eventObject, 'error')));
      };
      callRequired(nativeDevice, 'addEventListener', ['uncapturederror', listener]);
      return () => { callRequired(nativeDevice, 'removeEventListener', ['uncapturederror', listener]); };
    }
  };
  nativeDevices.set(port, nativeDevice);
  deviceOwners.set(port, owner);
  return port;
}

export function unwrapBrowserWebGPUDevice(device: WebGPUNativeDevicePort): object {
  const native = nativeDevices.get(device);
  if (native === undefined) throw new Error('WebGPU device was not created by the browser device port.');
  return native;
}

export function getBrowserWebGPUDeviceOwner(
  device: WebGPUNativeDevicePort
): BrowserWebGPUDeviceOwner {
  const owner = deviceOwners.get(device);
  if (owner === undefined) throw new Error('WebGPU device was not created by the browser device port.');
  return owner;
}

export function lowerBrowserDeviceRequest(
  nativeAdapter: object,
  request: WebGPUNativeDeviceRequest
): Promise<WebGPUNativeDevicePort> {
  return Promise.resolve(callRequired(nativeAdapter, 'requestDevice', [lowerBrowserDeviceDescriptor(request)]))
    .then((device) => createBrowserWebGPUDevicePort(device, request));
}

function createResource(
  nativeDevice: object,
  owner: BrowserWebGPUDeviceOwner,
  operation: string,
  descriptor: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): WebGPUNativeResourcePort {
  const lowered = lowerBrowserDescriptor(descriptor, keys, (value) => lowerResource(value, owner));
  const native = requireObject(callRequired(nativeDevice, operation, [lowered]), operation);
  return new BrowserWebGPUResourcePort(owner, native);
}

async function createResourceAsync(
  nativeDevice: object,
  owner: BrowserWebGPUDeviceOwner,
  operation: string,
  descriptor: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): Promise<WebGPUNativeResourcePort> {
  const lowered = lowerBrowserDescriptor(descriptor, keys, (value) => lowerResource(value, owner));
  const native = requireObject(await callRequired(nativeDevice, operation, [lowered]), operation);
  return new BrowserWebGPUResourcePort(owner, native);
}

function lowerResource(value: unknown, owner: BrowserWebGPUDeviceOwner): unknown {
  return value instanceof BrowserWebGPUResourcePort
    ? unwrapBrowserWebGPUResource(value, owner)
    : value;
}

function normalizeLostPromise(value: unknown): Promise<WebGPUNativeDeviceLostInfo> {
  const promise = requireObject(value, 'GPUDevice.lost');
  if (typeof Reflect.get(promise, 'then') !== 'function') {
    throw new TypeError('GPUDevice.lost is not Promise-like.');
  }
  return Promise.resolve(value as PromiseLike<unknown>).then((info) => {
    const record = requireObject(info, 'GPUDeviceLostInfo');
    const reason = Reflect.get(record, 'reason');
    const message = Reflect.get(record, 'message');
    return Object.freeze({
      ...(typeof reason === 'string' ? { reason } : {}),
      ...(typeof message === 'string' ? { message } : {})
    });
  });
}

function normalizeNativeError(value: unknown): WebGPUNativeErrorPort {
  const error = requireObject(value, 'GPUError');
  const name = Reflect.get(error, 'name');
  const message = Reflect.get(error, 'message');
  return Object.freeze({
    type: errorType(typeof name === 'string' ? name : ''),
    message: typeof message === 'string' ? message : String(value)
  });
}

function errorType(name: string): WebGPUNativeErrorType {
  if (name === 'GPUValidationError') return 'validation';
  if (name === 'GPUOutOfMemoryError') return 'out-of-memory';
  if (name === 'GPUInternalError') return 'internal';
  return 'unknown';
}

function callRequired(target: object, key: string, args: readonly unknown[]): unknown {
  const method = Reflect.get(target, key);
  if (typeof method !== 'function') throw new TypeError(`Native WebGPU object does not implement ${key}().`);
  return Reflect.apply(method, target, args);
}

function callOptional(target: object, key: string): void {
  const method = Reflect.get(target, key);
  if (typeof method === 'function') Reflect.apply(method, target, []);
}

function requireObject(value: unknown, label: string): object {
  if (typeof value !== 'object' || value === null) throw new TypeError(`${label} is not an object.`);
  return value;
}

function requireNumber(record: Readonly<Record<string, unknown>>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number') throw new TypeError(`WebGPU descriptor field ${key} must be a number.`);
  return value;
}
