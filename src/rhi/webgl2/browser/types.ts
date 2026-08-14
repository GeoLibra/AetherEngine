export interface BrowserWebGL2Canvas {
  getContext(contextId: 'webgl2', attributes?: Readonly<Record<string, unknown>>): unknown;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

export interface BrowserWebGL2ContextOptions {
  readonly alpha?: boolean;
  readonly depth?: boolean;
  readonly stencil?: boolean;
  readonly preserveDrawingBuffer?: boolean;
  readonly powerPreference?: 'default' | 'high-performance' | 'low-power';
}

export type BrowserWebGL2Object = object;

export interface BrowserWebGL2Context extends BrowserWebGL2Object {
  getSupportedExtensions(): string[] | null;
  getParameter(parameter: number): unknown;
  getShaderPrecisionFormat(
    shaderType: number,
    precisionType: number
  ): { readonly precision: number } | null;
  pixelStorei(parameter: number, value: number): void;
  disable(capability: number): void;
  colorMask(red: boolean, green: boolean, blue: boolean, alpha: boolean): void;
  depthMask(enabled: boolean): void;
  stencilMask(mask: number): void;
  bindBuffer(target: number, buffer: null): void;
  bindFramebuffer(target: number, framebuffer: null): void;
  bindRenderbuffer(target: number, renderbuffer: null): void;
  bindVertexArray(vertexArray: null): void;
  activeTexture(texture: number): void;
}
