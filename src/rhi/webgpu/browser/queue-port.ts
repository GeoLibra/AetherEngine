import type { WebGPUNativeQueuePort } from '../native-types';
import {
  unwrapBrowserWebGPUResource,
  type BrowserWebGPUDeviceOwner
} from './resource-port';
import { lowerBrowserDescriptor } from './descriptor-lowering';

export function createBrowserWebGPUQueuePort(
  nativeQueue: object,
  owner: BrowserWebGPUDeviceOwner
): WebGPUNativeQueuePort {
  return {
    submit(commandBuffers): void {
      callRequired(nativeQueue, 'submit', [
        commandBuffers.map((buffer) => unwrapBrowserWebGPUResource(buffer, owner))
      ]);
    },
    async onSubmittedWorkDone(): Promise<void> {
      await callRequired(nativeQueue, 'onSubmittedWorkDone', []);
    },
    writeBuffer(buffer, offset, data): void {
      callRequired(nativeQueue, 'writeBuffer', [
        unwrapBrowserWebGPUResource(buffer, owner), offset, data
      ]);
    },
    writeTexture(destination, data, dataLayout, size): void {
      callRequired(nativeQueue, 'writeTexture', [
        lowerBrowserDescriptor(destination, Object.keys(destination), (value) =>
          lowerResource(value, owner)),
        data,
        dataLayout,
        size
      ]);
    }
  };
}

function lowerResource(value: unknown, owner: BrowserWebGPUDeviceOwner): unknown {
  return typeof value === 'object' && value !== null && 'owner' in value
    ? unwrapBrowserWebGPUResource(value, owner)
    : value;
}

function callRequired(target: object, key: string, args: readonly unknown[]): unknown {
  const method = Reflect.get(target, key);
  if (typeof method !== 'function') throw new TypeError(`Native WebGPU object does not implement ${key}().`);
  return Reflect.apply(method, target, args);
}
