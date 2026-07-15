import type { GPUIndexFormat } from '../contracts/webgpu';
import type { WebGL2Metrics } from './metrics';
import type { WebGL2NativeContextPort, WebGL2NativeObject } from './native-types';

const UNKNOWN = Symbol('unknown-webgl2-state');

interface BufferState {
  readonly handle: WebGL2NativeObject;
  readonly offset: number;
  readonly size?: number;
}

export class WebGL2StateVM {
  private program: WebGL2NativeObject | typeof UNKNOWN = UNKNOWN;
  private rasterKey: object | typeof UNKNOWN = UNKNOWN;
  private depthStencilKey: object | typeof UNKNOWN = UNKNOWN;
  private framebuffer: WebGL2NativeObject | typeof UNKNOWN = UNKNOWN;
  private vertexArray: WebGL2NativeObject | typeof UNKNOWN = UNKNOWN;
  private viewport: readonly number[] | typeof UNKNOWN = UNKNOWN;
  private scissor: readonly number[] | typeof UNKNOWN = UNKNOWN;
  private indexBuffer: (BufferState & { readonly format: GPUIndexFormat }) | typeof UNKNOWN = UNKNOWN;
  private readonly vertexBuffers = new Map<number, BufferState>();
  private readonly uniformBuffers = new Map<number, BufferState>();
  private readonly textures = new Map<number, WebGL2NativeObject>();
  private readonly samplers = new Map<number, WebGL2NativeObject>();

  constructor(
    private readonly native: WebGL2NativeContextPort,
    private readonly metrics: WebGL2Metrics
  ) {}

  invalidate(): void {
    this.program = UNKNOWN;
    this.rasterKey = UNKNOWN;
    this.depthStencilKey = UNKNOWN;
    this.framebuffer = UNKNOWN;
    this.vertexArray = UNKNOWN;
    this.viewport = UNKNOWN;
    this.scissor = UNKNOWN;
    this.indexBuffer = UNKNOWN;
    this.vertexBuffers.clear();
    this.uniformBuffers.clear();
    this.textures.clear();
    this.samplers.clear();
  }

  applyProgram(program: WebGL2NativeObject): void {
    if (this.program === program) {
      this.metrics.recordProgramCacheHit();
      return this.skip();
    }
    this.call('useProgram', program);
    this.program = program;
    this.metrics.recordProgramCacheMiss();
  }

  applyRasterState(key: object, state: Readonly<Record<string, unknown>>): void {
    if (this.rasterKey === key) return this.skip();
    this.call('setRasterState', state);
    this.rasterKey = key;
  }

  applyDepthStencilState(key: object, state: Readonly<Record<string, unknown>>): void {
    if (this.depthStencilKey === key) return this.skip();
    this.call('setDepthStencilState', state);
    this.depthStencilKey = key;
  }

  applyFramebuffer(handle: WebGL2NativeObject): void {
    if (this.framebuffer === handle) return this.skip();
    this.call('bindFramebuffer', handle);
    this.framebuffer = handle;
  }

  applyVertexArray(handle: WebGL2NativeObject): void {
    if (this.vertexArray === handle) return this.skip();
    this.call('bindVertexArray', handle);
    this.vertexArray = handle;
  }

  applyViewport(values: readonly [number, number, number, number, number, number]): void {
    if (sameNumbers(this.viewport, values)) return this.skip();
    this.call('setViewport', ...values);
    this.viewport = values;
  }

  applyScissor(values: readonly [number, number, number, number]): void {
    if (sameNumbers(this.scissor, values)) return this.skip();
    this.call('setScissorRect', ...values);
    this.scissor = values;
  }

  applyVertexBuffer(slot: number, handle: WebGL2NativeObject, offset: number, size?: number): void {
    const current = this.vertexBuffers.get(slot);
    if (sameBuffer(current, handle, offset, size)) return this.skip();
    this.call('bindVertexBuffer', slot, handle, offset, size);
    this.vertexBuffers.set(slot, optionalSize(handle, offset, size));
  }

  applyIndexBuffer(handle: WebGL2NativeObject, format: GPUIndexFormat, offset: number, size?: number): void {
    const current = this.indexBuffer;
    if (current !== UNKNOWN && current.format === format && sameBuffer(current, handle, offset, size)) return this.skip();
    this.call('bindIndexBuffer', handle, format, offset, size);
    this.indexBuffer = { ...optionalSize(handle, offset, size), format };
  }

  applyUniformBuffer(binding: number, handle: WebGL2NativeObject, offset: number, size: number): void {
    const current = this.uniformBuffers.get(binding);
    if (sameBuffer(current, handle, offset, size)) return this.skip();
    this.call('bindUniformBuffer', binding, handle, offset, size);
    this.uniformBuffers.set(binding, { handle, offset, size });
  }

  applyTexture(unit: number, handle: WebGL2NativeObject): void {
    if (this.textures.get(unit) === handle) return this.skip();
    this.call('bindTexture', unit, handle);
    this.textures.set(unit, handle);
  }

  applySampler(unit: number, handle: WebGL2NativeObject): void {
    if (this.samplers.get(unit) === handle) return this.skip();
    this.call('bindSampler', unit, handle);
    this.samplers.set(unit, handle);
  }

  private call(name: keyof WebGL2NativeContextPort, ...args: unknown[]): void {
    const operation = this.native[name];
    if (typeof operation !== 'function') throw new Error(`Native WebGL2 context does not support ${String(name)}.`);
    (operation as (...values: unknown[]) => void).call(this.native, ...args);
    this.metrics.recordGLCall();
  }

  private skip(): void { this.metrics.recordStateSkip(); }
}

function sameNumbers(current: readonly number[] | typeof UNKNOWN, next: readonly number[]): boolean {
  return current !== UNKNOWN && current.length === next.length && current.every((value, index) => value === next[index]);
}

function sameBuffer(current: BufferState | undefined, handle: WebGL2NativeObject, offset: number, size?: number): boolean {
  return current !== undefined && current.handle === handle && current.offset === offset && current.size === size;
}

function optionalSize(handle: WebGL2NativeObject, offset: number, size?: number): BufferState {
  return size === undefined ? { handle, offset } : { handle, offset, size };
}
