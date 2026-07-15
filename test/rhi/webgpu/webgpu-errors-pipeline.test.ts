import { describe, expect, test } from 'vitest';
import {
  DiagnosticStore,
  WebGPUAdapter,
  WebGPUNativeOperationError,
  type Diagnostic,
  type RHIComputePipeline,
  type RHIRenderPipeline,
  type WebGPUNativeAdapterPort,
  type WebGPUNativeDevicePort,
  type WebGPUNativeDeviceRequest,
  type WebGPUNativeResourcePort
} from '../../../src';

interface NativeError {
  readonly type: 'validation' | 'out-of-memory' | 'internal' | 'unknown';
  readonly message: string;
  readonly source?: { readonly uri: string; readonly line?: number; readonly column?: number };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

type PipelineResult<T> =
  | { readonly status: 'success'; readonly pipeline: T }
  | { readonly status: 'failed'; readonly diagnostic: Diagnostic };

class NativeResource implements WebGPUNativeResourcePort {}

class NativeDevice implements WebGPUNativeDevicePort {
  readonly lost = new Promise<never>(() => undefined);
  readonly queue = { submit(): void {}, onSubmittedWorkDone: async () => undefined };
  readonly pushedScopes: string[] = [];
  readonly scopeEvents: string[] = [];
  readonly scopedErrors: Array<NativeError | null> = [];
  readonly controlledRenderPipelines: Promise<WebGPUNativeResourcePort>[] = [];
  syncPipelineError: unknown;
  renderAsyncCalls = 0;
  computeAsyncCalls = 0;
  private uncapturedHandler: ((error: NativeError) => void) | undefined;

  createShaderModule(): WebGPUNativeResourcePort { return new NativeResource(); }
  createRenderPipeline(): WebGPUNativeResourcePort {
    if (this.syncPipelineError !== undefined) throw this.syncPipelineError;
    return new NativeResource();
  }
  async createRenderPipelineAsync(): Promise<WebGPUNativeResourcePort> {
    this.renderAsyncCalls += 1;
    const controlled = this.controlledRenderPipelines.shift();
    if (controlled !== undefined) return controlled;
    return new NativeResource();
  }
  async createComputePipelineAsync(): Promise<WebGPUNativeResourcePort> {
    this.computeAsyncCalls += 1;
    return new NativeResource();
  }
  pushErrorScope(filter: string): void {
    this.pushedScopes.push(filter);
    this.scopeEvents.push('push');
  }
  async popErrorScope(): Promise<NativeError | null> {
    this.scopeEvents.push('pop');
    return this.scopedErrors.shift() ?? null;
  }
  setUncapturedErrorHandler(handler: (error: NativeError) => void): () => void {
    this.uncapturedHandler = handler;
    return () => { this.uncapturedHandler = undefined; };
  }
  emitUncaptured(error: NativeError): void { this.uncapturedHandler?.(error); }
}

class NativeAdapter implements WebGPUNativeAdapterPort {
  readonly info = { name: 'Diagnostic Adapter' };
  readonly features = new Set<string>();
  readonly limits = {};
  readonly formats = new Map();
  readonly device = new NativeDevice();
  async requestDevice(_request: WebGPUNativeDeviceRequest): Promise<WebGPUNativeDevicePort> { return this.device; }
}

async function createDevice() {
  const native = new NativeAdapter();
  const diagnostics = new DiagnosticStore();
  const device = await new WebGPUAdapter(native, diagnostics).requestDevice({
    requiredFeatures: [],
    optionalFeatures: []
  });
  return { device, native: native.device, diagnostics };
}

describe('WebGPU errors and async pipelines', () => {
  test('wraps synchronous native creation failures with operation and label context', async () => {
    const { device, native } = await createDevice();
    const shader = device.createShaderModule({ code: '@vertex fn main() {}' });
    const cause = new Error('native validation failed');
    native.syncPipelineError = cause;

    expect(() => device.createRenderPipeline({
      label: 'main-pipeline',
      vertex: { module: shader }
    })).toThrow(WebGPUNativeOperationError);
    expect(() => device.createRenderPipeline({
      label: 'main-pipeline',
      vertex: { module: shader }
    })).toThrow(expect.objectContaining({
      code: 'rhi/webgpu-native-operation-failed',
      operation: 'createRenderPipeline',
      resourceLabel: 'main-pipeline',
      cause
    }));
  });

  test('routes uncaptured native errors into the shared diagnostic store', async () => {
    const { native, diagnostics } = await createDevice();

    native.emitUncaptured({
      type: 'validation',
      message: 'binding 3 is invalid',
      source: { uri: 'shader://material', line: 12, column: 4 }
    });

    expect(diagnostics.list()).toEqual([{
      code: 'rhi/webgpu-uncaptured-validation',
      severity: 'error',
      message: 'binding 3 is invalid',
      subsystem: 'rhi.webgpu',
      source: { uri: 'shader://material', line: 12, column: 4 },
      context: { deviceGeneration: expect.any(Number), errorType: 'validation' }
    }]);
  });

  test('creates render and compute pipelines asynchronously without using sync creation', async () => {
    const { device, native } = await createDevice();
    const vertex = device.createShaderModule({ code: '@vertex fn main() {}' });
    const compute = device.createShaderModule({ code: '@compute @workgroup_size(1) fn main() {}' });

    const renderResult = await device.createRenderPipelineAsync({
      label: 'async-render',
      vertex: { module: vertex }
    }) as PipelineResult<RHIRenderPipeline>;
    const computeResult = await device.createComputePipelineAsync({
      label: 'async-compute',
      compute: { module: compute }
    }) as PipelineResult<RHIComputePipeline>;

    expect(renderResult).toMatchObject({ status: 'success', pipeline: { label: 'async-render' } });
    expect(computeResult).toMatchObject({ status: 'success', pipeline: { label: 'async-compute' } });
    expect(native.renderAsyncCalls).toBe(1);
    expect(native.computeAsyncCalls).toBe(1);
    expect(native.pushedScopes).toEqual(['validation', 'validation']);
  });

  test('returns and records a source-mapped diagnostic from an async error scope', async () => {
    const { device, native, diagnostics } = await createDevice();
    const shader = device.createShaderModule({ code: '@vertex fn main() {}' });
    native.scopedErrors.push({
      type: 'validation',
      message: 'fragment output does not match target',
      source: { uri: 'flux://terrain', line: 8 }
    });

    const result = await device.createRenderPipelineAsync({
      label: 'terrain-pipeline',
      vertex: { module: shader }
    }) as PipelineResult<RHIRenderPipeline>;

    expect(result).toEqual({
      status: 'failed',
      diagnostic: expect.objectContaining({
        code: 'rhi/webgpu-pipeline-validation',
        message: 'fragment output does not match target',
        source: { uri: 'flux://terrain', line: 8 },
        context: {
          deviceGeneration: device.generation,
          errorType: 'validation',
          operation: 'createRenderPipelineAsync',
          resourceLabel: 'terrain-pipeline'
        }
      })
    });
    expect(diagnostics.list({ code: 'rhi/webgpu-pipeline-validation' })).toHaveLength(1);
  });

  test('balances error scopes before awaiting concurrent native pipeline compilation', async () => {
    const { device, native } = await createDevice();
    const shader = device.createShaderModule({ code: '@vertex fn main() {}' });
    const firstNative = deferred<WebGPUNativeResourcePort>();
    const secondNative = deferred<WebGPUNativeResourcePort>();
    native.controlledRenderPipelines.push(firstNative.promise, secondNative.promise);

    const first = device.createRenderPipelineAsync({ label: 'first', vertex: { module: shader } });
    const second = device.createRenderPipelineAsync({ label: 'second', vertex: { module: shader } });

    expect(native.scopeEvents).toEqual(['push', 'pop', 'push', 'pop']);
    firstNative.resolve(new NativeResource());
    secondNative.resolve(new NativeResource());
    await expect(first).resolves.toMatchObject({ status: 'success' });
    await expect(second).resolves.toMatchObject({ status: 'success' });
  });

  test('unsubscribes the uncaptured error hook when the device is destroyed', async () => {
    const { device, native, diagnostics } = await createDevice();
    native.emitUncaptured({ type: 'internal', message: 'first native error' });
    expect(diagnostics.list()).toHaveLength(1);
    device.destroy();

    native.emitUncaptured({ type: 'internal', message: 'late native error' });

    expect(diagnostics.list()).toHaveLength(1);
  });
});
