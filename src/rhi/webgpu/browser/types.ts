export interface BrowserWebGPU {
  requestAdapter(options?: Readonly<Record<string, unknown>>): Promise<unknown>;
  getPreferredCanvasFormat?(): string;
}

export interface BrowserGPUCanvasContext {
  configure(configuration: unknown): void;
}

export interface BrowserWebGPUCanvas {
  getContext(contextId: 'webgpu'): unknown;
}

export interface BrowserWebGPUGlobalObject {
  readonly navigator?: {
    readonly gpu?: BrowserWebGPU;
  };
}

export interface BrowserWebGPUEnvironment {
  readonly gpu: BrowserWebGPU;
  getCanvasContext(canvas: BrowserWebGPUCanvas): BrowserGPUCanvasContext | null;
}
