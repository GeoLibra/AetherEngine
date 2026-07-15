import type {
  WebGPUNativeDevicePort,
  WebGPUNativeErrorPort,
  WebGPUNativeResourcePort
} from './native-types';
import { normalizeWebGPUNativeError } from './diagnostics';

export type WebGPUNativePipelineResult =
  | { readonly status: 'success'; readonly native: WebGPUNativeResourcePort }
  | { readonly status: 'failed'; readonly error: WebGPUNativeErrorPort };

export async function createWebGPUNativePipeline(
  device: WebGPUNativeDevicePort,
  create: () => Promise<WebGPUNativeResourcePort>
): Promise<WebGPUNativePipelineResult> {
  const usesScope = device.pushErrorScope !== undefined && device.popErrorScope !== undefined;
  if (usesScope) device.pushErrorScope?.('validation');

  let creation: Promise<WebGPUNativeResourcePort>;
  try {
    creation = create();
  } catch (cause) {
    creation = Promise.reject(cause);
  }

  // Error scopes are stack-based: pop immediately after starting native work, then await both promises.
  let scopeResult: Promise<WebGPUNativeErrorPort | null> = Promise.resolve(null);
  if (usesScope) {
    try {
      scopeResult = device.popErrorScope?.() ?? Promise.resolve(null);
    } catch (cause) {
      scopeResult = Promise.resolve(normalizeWebGPUNativeError(cause));
    }
  }

  const [creationResult, scoped] = await Promise.all([
    creation.then(
      (native) => ({ native } as const),
      (cause: unknown) => ({ error: normalizeWebGPUNativeError(cause) } as const)
    ),
    scopeResult.catch((cause: unknown) => normalizeWebGPUNativeError(cause))
  ]);
  const error = scoped ?? ('error' in creationResult ? creationResult.error : undefined);
  if (error !== undefined) return Object.freeze({ status: 'failed', error });
  if ('native' in creationResult) return Object.freeze({ status: 'success', native: creationResult.native });
  return Object.freeze({ status: 'failed', error: creationResult.error });
}
