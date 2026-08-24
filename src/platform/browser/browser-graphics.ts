import { WebGPUAdapter } from '../../rhi/webgpu/adapter';
import { WebGPUSurface } from '../../rhi/webgpu/surface';
import { createBrowserWebGPUCanvasContextPort } from '../../rhi/webgpu/browser/canvas-context-port';
import {
  getBrowserWebGPUEnvironment,
  requestBrowserWebGPUAdapter,
  type BrowserWebGPUGlobalObject
} from '../../rhi/webgpu/browser';
import type { RHISurfaceConfiguration } from '../../rhi/contracts/surface';
import type { SurfaceTarget } from '../types';
import { WebGL2Adapter } from '../../rhi/webgl2/adapter';
import { createBrowserWebGL2ContextPort, WebGL2BrowserSurface } from '../../rhi/webgl2/browser';
import type { BrowserWebGL2Canvas } from '../../rhi/webgl2/browser';
import { BrowserGraphicsBootstrapError } from './browser-graphics-error';
import type {
  BrowserGraphicsAttempt,
  BrowserGraphicsLifecycleEvent,
  BrowserGraphicsLoss,
  BrowserGraphicsOptions,
  BrowserGraphicsSession,
  PhysicalSize
} from '../types';

export async function createBrowserGraphics(
  options: BrowserGraphicsOptions
): Promise<BrowserGraphicsSession> {
  validateSize(options.surface);
  const preference = options.preference ?? ['webgpu', 'webgl2'];
  if (preference[0] === 'webgl2' || !preference.includes('webgpu'))
    return createWebGL2Session(options, []);

  let environment;
  try {
    environment =
      options.environment ??
      getBrowserWebGPUEnvironment(globalThis as unknown as BrowserWebGPUGlobalObject);
  } catch (cause) {
    const attempts = [attempt('webgpu', 'environment', 'unavailable', messageOf(cause))];
    if (preference.includes('webgl2')) return createWebGL2Session(options, attempts);
    throw unavailable(attempts);
  }

  const nativeAdapter = await requestBrowserWebGPUAdapter(environment, {
    ...(options.powerPreference === undefined ? {} : { powerPreference: options.powerPreference })
  });
  if (nativeAdapter === null) {
    const attempts = [
      attempt('webgpu', 'adapter', 'unavailable', 'navigator.gpu.requestAdapter() returned null.')
    ];
    if (preference.includes('webgl2')) return createWebGL2Session(options, attempts);
    throw unavailable(attempts);
  }

  const adapter = new WebGPUAdapter(nativeAdapter);
  let device;
  try {
    device = await adapter.requestDevice(options.device);
  } catch (cause) {
    const attempts = [attempt('webgpu', 'device', 'unsupported', messageOf(cause))];
    if (preference.includes('webgl2')) return createWebGL2Session(options, attempts);
    throw unavailable(attempts);
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
  const listeners = new Set<(event: BrowserGraphicsLifecycleEvent) => void>();
  const emit = (event: BrowserGraphicsLifecycleEvent): void => {
    const snapshot = Object.freeze(event);
    for (const listener of [...listeners]) listener(snapshot);
  };
  let surfaceGeneration = 1;
  const settleLoss = (
    stage: BrowserGraphicsLoss['stage'],
    reason: string,
    generation: number
  ): void => {
    if (lossSettled) return;
    lossSettled = true;
    const loss = Object.freeze({
      backend: 'webgpu',
      stage,
      reason,
      generation,
      recreationAllowed: reason !== 'destroyed'
    });
    resolveLost(loss);
    emit({ kind: 'lost', loss });
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
    subscribe(listener: (event: BrowserGraphicsLifecycleEvent) => void): () => boolean {
      if (destroyed) throw new Error('Browser graphics session has been destroyed.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resize(size: PhysicalSize): void {
      if (destroyed) throw new Error('Browser graphics session has been destroyed.');
      validateSize(size);
      if (size.width === configuration.width && size.height === configuration.height) return;
      configuration = Object.freeze({ ...configuration, width: size.width, height: size.height });
      windowGeneration += 1;
      surfaceGeneration = windowGeneration;
      setCanvasExtent(options.canvas, size);
      surface.configure(device, configuration, windowGeneration);
      emit({ kind: 'reconfigured', generation: surface.generation });
    },
    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
      surface.dispose();
      device.destroy();
    }
  });
}

async function createWebGL2Session(
  options: BrowserGraphicsOptions,
  priorAttempts: readonly BrowserGraphicsAttempt[]
): Promise<BrowserGraphicsSession> {
  const canvas = options.canvas as unknown as BrowserWebGL2Canvas;
  if (
    typeof Reflect.get(canvas, 'addEventListener') !== 'function' ||
    typeof Reflect.get(canvas, 'removeEventListener') !== 'function'
  ) {
    throw unavailable([
      ...priorAttempts,
      attempt('webgl2', 'environment', 'unavailable', 'Target canvas lacks context event APIs.')
    ]);
  }
  const native = createBrowserWebGL2ContextPort(canvas, {
    powerPreference: options.powerPreference ?? 'default',
    alpha: options.surface.alphaMode !== 'opaque',
    ...(options.webgl2ClipControl === undefined ? {} : { clipControl: options.webgl2ClipControl })
  });
  if (native === null) {
    throw unavailable([
      ...priorAttempts,
      attempt('webgl2', 'context', 'unavailable', 'Target canvas did not return a WebGL2 context.')
    ]);
  }
  const adapter = new WebGL2Adapter(native, options.webgl2Translator);
  let device;
  try {
    device = await adapter.requestDevice(options.device);
  } catch (cause) {
    native.destroy?.();
    throw unavailable([
      ...priorAttempts,
      attempt('webgl2', 'device', 'unsupported', messageOf(cause))
    ]);
  }
  const target: SurfaceTarget = Object.freeze({ id: Symbol('browser-canvas'), kind: 'canvas' });
  const surface = new WebGL2BrowserSurface(target);
  let configuration = createConfiguration(options, 'rgba8unorm');
  let generation = 1;
  setCanvasExtent(options.canvas, configuration);
  surface.configure(device, configuration, generation);
  let destroyed = false;
  const listeners = new Set<(event: BrowserGraphicsLifecycleEvent) => void>();
  const emit = (event: BrowserGraphicsLifecycleEvent): void => {
    const snapshot = Object.freeze(event);
    for (const listener of [...listeners]) listener(snapshot);
  };
  const lost = device.lost.then((info) => {
    const loss = Object.freeze({
      backend: 'webgl2' as const,
      stage: 'context' as const,
      reason: info.reason,
      generation: info.generation,
      recreationAllowed: info.reason !== 'destroyed'
    });
    emit({ kind: 'lost', loss });
    return loss;
  });
  return Object.freeze({
    backend: 'webgl2' as const,
    adapter,
    device,
    surface,
    lost,
    subscribe(listener: (event: BrowserGraphicsLifecycleEvent) => void): () => boolean {
      if (destroyed) throw new Error('Browser graphics session has been destroyed.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resize(size: PhysicalSize): void {
      if (destroyed) throw new Error('Browser graphics session has been destroyed.');
      validateSize(size);
      if (size.width === configuration.width && size.height === configuration.height) return;
      configuration = Object.freeze({ ...configuration, ...size });
      generation += 1;
      setCanvasExtent(options.canvas, size);
      surface.configure(device, configuration, generation);
      emit({ kind: 'reconfigured', generation: surface.generation });
    },
    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
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
