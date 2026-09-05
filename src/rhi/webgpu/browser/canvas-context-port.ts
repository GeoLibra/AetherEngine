import type {
  WebGPUNativeCanvasContextPort,
  WebGPUNativeSurfaceAcquireResult,
  WebGPUNativeSurfaceConfiguration
} from '../types';
import { BrowserWebGPUTexturePort, type BrowserWebGPUDeviceOwner } from './resource-port';
import { getBrowserWebGPUDeviceOwner, unwrapBrowserWebGPUDevice } from './device-port';

const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;

export function createBrowserWebGPUCanvasContextPort(
  nativeContext: object,
  onFailure?: (stage: 'surface' | 'context', cause: unknown) => void,
  canUnconfigure?: () => boolean
): WebGPUNativeCanvasContextPort {
  let owner: BrowserWebGPUDeviceOwner | undefined;
  return {
    configure(configuration): void {
      try {
        const nativeDevice = unwrapBrowserWebGPUDevice(configuration.device);
        owner = getBrowserWebGPUDeviceOwner(configuration.device);
        callRequired(nativeContext, 'configure', [
          lowerCanvasConfiguration(configuration, nativeDevice)
        ]);
      } catch (cause) {
        onFailure?.('context', cause);
        throw cause;
      }
    },
    getCurrentTexture(): WebGPUNativeSurfaceAcquireResult {
      if (owner === undefined) return Object.freeze({ status: 'outdated' });
      try {
        const texture = requireObject(
          callRequired(nativeContext, 'getCurrentTexture', []),
          'GPUCanvasContext.getCurrentTexture()'
        );
        return Object.freeze({
          status: 'success',
          texture: new BrowserWebGPUTexturePort(owner, texture)
        });
      } catch (cause) {
        onFailure?.('surface', cause);
        return Object.freeze({ status: 'lost' });
      }
    },
    unconfigure(): void {
      owner = undefined;
      if (canUnconfigure === undefined || canUnconfigure()) {
        callOptional(nativeContext, 'unconfigure');
      }
    }
  };
}

function lowerCanvasConfiguration(
  configuration: WebGPUNativeSurfaceConfiguration,
  nativeDevice: object
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    device: nativeDevice,
    format: configuration.format,
    usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
    alphaMode: configuration.alphaMode,
    colorSpace: configuration.colorSpace
  });
}

function callRequired(target: object, key: string, args: readonly unknown[]): unknown {
  const method = Reflect.get(target, key);
  if (typeof method !== 'function')
    throw new TypeError(`GPUCanvasContext does not implement ${key}().`);
  return Reflect.apply(method, target, args);
}

function callOptional(target: object, key: string): void {
  const method = Reflect.get(target, key);
  if (typeof method === 'function') Reflect.apply(method, target, []);
}

function requireObject(value: unknown, label: string): object {
  if (typeof value !== 'object' || value === null)
    throw new TypeError(`${label} is not an object.`);
  return value;
}
