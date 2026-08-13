import { WebGPUAdapter } from '../rhi/webgpu/adapter';
import { WebGPUSurface } from '../rhi/webgpu/surface';
import { createBrowserWebGPUCanvasContextPort } from '../rhi/webgpu/browser/canvas-context-port';
import {
  getBrowserWebGPUEnvironment,
  requestBrowserWebGPUAdapter,
  type BrowserWebGPUGlobalObject
} from '../rhi/webgpu/browser';
import type { RHISurfaceConfiguration } from '../rhi/contracts/surface';
import type { SurfaceTarget } from './types';
import {
  BrowserGraphicsBootstrapError,
  type BrowserGraphicsAttempt,
  type BrowserGraphicsLoss,
  type BrowserGraphicsOptions,
  type BrowserGraphicsSession,
  type PhysicalSize
} from './browser-graphics-types';

export async function createBrowserGraphics(
  options: BrowserGraphicsOptions
): Promise<BrowserGraphicsSession> {
  validateSize(options.surface);
  const preference = options.preference ?? ['webgpu', 'webgl2'];
  if (!preference.includes('webgpu')) {
    throw unavailable([
      attempt('webgl2', 'environment', 'unsupported', 'WebGL2 backend is not implemented yet.')
    ]);
  }

  let environment;
  try {
    environment =
      options.environment ??
      getBrowserWebGPUEnvironment(globalThis as unknown as BrowserWebGPUGlobalObject);
  } catch (cause) {
    throw unavailable([attempt('webgpu', 'environment', 'unavailable', messageOf(cause))]);
  }

  const nativeAdapter = await requestBrowserWebGPUAdapter(environment, {
    ...(options.powerPreference === undefined ? {} : { powerPreference: options.powerPreference })
  });
  if (nativeAdapter === null) {
    throw unavailable([
      attempt('webgpu', 'adapter', 'unavailable', 'navigator.gpu.requestAdapter() returned null.')
    ]);
  }

  const adapter = new WebGPUAdapter(nativeAdapter);
  let device;
  try {
    device = await adapter.requestDevice(options.device);
  } catch (cause) {
    throw unavailable([attempt('webgpu', 'device', 'unsupported', messageOf(cause))]);
  }

  // This is the first operation allowed to attach the target canvas.
  const nativeContext = environment.getCanvasContext(options.canvas);
  if (nativeContext === null) {
    device.destroy();
    throw unavailable([
      attempt('webgpu', 'context', 'failure', 'Target canvas did not return a WebGPU context.')
    ]);
  }

  const target: SurfaceTarget = Object.freeze({ id: Symbol('browser-canvas'), kind: 'canvas' });
  let resolveLost!: (loss: BrowserGraphicsLoss) => void;
  let lossSettled = false;
  const lost = new Promise<BrowserGraphicsLoss>((resolve) => {
    resolveLost = resolve;
  });
  let surfaceGeneration = 1;
  const settleLoss = (
    stage: BrowserGraphicsLoss['stage'],
    reason: string,
    generation: number
  ): void => {
    if (lossSettled) return;
    lossSettled = true;
    resolveLost(
      Object.freeze({
        backend: 'webgpu',
        stage,
        reason,
        generation,
        recreationAllowed: reason !== 'destroyed'
      })
    );
  };
  const surface = new WebGPUSurface(
    target,
    createBrowserWebGPUCanvasContextPort(nativeContext, (stage, cause) => {
      settleLoss(stage, messageOf(cause), surfaceGeneration);
    })
  );
  let configuration = createConfiguration(options, environment.gpu.getPreferredCanvasFormat?.());
  let windowGeneration = 1;
  try {
    setCanvasExtent(options.canvas, configuration);
    surface.configure(device, configuration, windowGeneration);
  } catch (cause) {
    surface.dispose();
    device.destroy();
    throw unavailable([attempt('webgpu', 'surface', 'failure', messageOf(cause))]);
  }

  let destroyed = false;
  void device.lost.then((info) => settleLoss('device', info.reason, info.generation));

  return Object.freeze({
    backend: 'webgpu' as const,
    adapter,
    device,
    surface,
    lost,
    resize(size: PhysicalSize): void {
      if (destroyed) throw new Error('Browser graphics session has been destroyed.');
      validateSize(size);
      if (size.width === configuration.width && size.height === configuration.height) return;
      configuration = Object.freeze({ ...configuration, width: size.width, height: size.height });
      windowGeneration += 1;
      surfaceGeneration = windowGeneration;
      setCanvasExtent(options.canvas, size);
      surface.configure(device, configuration, windowGeneration);
    },
    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      surface.dispose();
      device.destroy();
    }
  });
}

function setCanvasExtent(canvas: BrowserGraphicsOptions['canvas'], size: PhysicalSize): void {
  if ('width' in canvas) canvas.width = size.width;
  if ('height' in canvas) canvas.height = size.height;
}

function createConfiguration(
  options: BrowserGraphicsOptions,
  preferredFormat: string | undefined
): RHISurfaceConfiguration {
  const format = options.surface.format ?? preferredFormat ?? 'bgra8unorm';
  return Object.freeze({
    format: format as RHISurfaceConfiguration['format'],
    colorSpace: options.surface.colorSpace ?? 'srgb',
    alphaMode: options.surface.alphaMode ?? 'premultiplied',
    width: options.surface.width,
    height: options.surface.height,
    presentMode: 'fifo'
  });
}

function validateSize(size: PhysicalSize): void {
  for (const [name, value] of [
    ['width', size.width],
    ['height', size.height]
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(`Browser surface ${name} must be a non-negative integer.`);
    }
  }
}

function attempt(
  backend: BrowserGraphicsAttempt['backend'],
  stage: BrowserGraphicsAttempt['stage'],
  classification: BrowserGraphicsAttempt['classification'],
  message: string
): BrowserGraphicsAttempt {
  return Object.freeze({ backend, stage, classification, message });
}

function unavailable(attempts: readonly BrowserGraphicsAttempt[]): BrowserGraphicsBootstrapError {
  return new BrowserGraphicsBootstrapError(Object.freeze([...attempts]));
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
