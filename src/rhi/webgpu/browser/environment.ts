import type {
  BrowserGPUCanvasContext,
  BrowserWebGPUCanvas,
  BrowserWebGPUEnvironment,
  BrowserWebGPUGlobalObject
} from './types';

export function getBrowserWebGPUEnvironment(
  globalObject: BrowserWebGPUGlobalObject
): BrowserWebGPUEnvironment {
  const gpu = globalObject.navigator?.gpu;
  if (gpu === undefined) {
    throw new Error('WebGPU is unavailable: navigator.gpu is missing');
  }

  return Object.freeze({
    gpu,
    getCanvasContext(canvas: BrowserWebGPUCanvas): BrowserGPUCanvasContext | null {
      const context = canvas.getContext('webgpu');
      return context === null ? null : context as BrowserGPUCanvasContext;
    }
  });
}
