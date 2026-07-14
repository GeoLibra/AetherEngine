import type {
  NativeBridgeDispatcherOptions,
  NativeBridgeErrorCode,
  NativeBridgeInvocation,
  NativeBridgeRequest,
  NativeBridgeResponse,
  NativeCancellationToken,
  NativeMethodDescriptor
} from './bridge-types';

export class NativeBridgeError extends Error {
  constructor(readonly code: NativeBridgeErrorCode) {
    super(`Native bridge call failed (${code}).`);
    this.name = 'NativeBridgeError';
  }
}

export class NativeBridgeDispatcher {
  private readonly methods = new Map<string, NativeMethodDescriptor<unknown, unknown>>();
  private nextRequestId = 1;

  constructor(private readonly options: NativeBridgeDispatcherOptions) {
    const modules = new Map(options.handshake.modules.map((module) => [module.name, module.version]));
    for (const method of options.methods) {
      if (method.module === 'rhi') throw new Error('The rhi module is reserved for the direct native RHI path.');
      const version = modules.get(method.module);
      if (version === undefined) throw new Error(`Native bridge module "${method.module}" was not negotiated.`);
      if (version < method.version) throw new Error(`Native bridge module "${method.module}" version is too old.`);
      if (!Number.isSafeInteger(method.version) || method.version <= 0) {
        throw new Error('Native bridge method version must be a positive safe integer.');
      }
      if (!Number.isSafeInteger(method.maxRequestBytes) || method.maxRequestBytes <= 0) {
        throw new Error('Native bridge request limit must be a positive safe integer.');
      }
      const key = methodKey(method);
      if (this.methods.has(key)) throw new Error(`Duplicate native bridge method "${key}".`);
      this.methods.set(key, method);
    }
  }

  call<I, O>(
    descriptor: NativeMethodDescriptor<I, O>,
    payload: I,
    cancellation?: NativeCancellationToken
  ): Promise<O> {
    const registered = this.methods.get(methodKey(descriptor));
    if (registered !== descriptor) return Promise.reject(new NativeBridgeError('unknown-method'));
    if (!descriptor.validateRequest(payload)) return Promise.reject(new NativeBridgeError('invalid-request'));
    const encoded = encodePayload(payload);
    if (encoded === undefined || !descriptor.validateRequest(encoded.payload)) {
      return Promise.reject(new NativeBridgeError('invalid-request'));
    }
    if (encoded.bytes > descriptor.maxRequestBytes) {
      return Promise.reject(new NativeBridgeError('request-too-large'));
    }
    const request = Object.freeze({
      id: this.allocateRequestId(),
      module: descriptor.module,
      method: descriptor.method,
      version: descriptor.version,
      payload: encoded.payload
    });
    return this.dispatch(request, descriptor, cancellation);
  }

  private dispatch<I, O>(
    request: NativeBridgeRequest,
    descriptor: NativeMethodDescriptor<I, O>,
    cancellation?: NativeCancellationToken
  ): Promise<O> {
    return new Promise<O>((resolve, reject) => {
      let terminal = false;
      let invocation: NativeBridgeInvocation | undefined;
      let cancelPending = false;
      let unsubscribe = () => false;
      const settle = (response: NativeBridgeResponse): void => {
        if (terminal || response.id !== request.id) return;
        terminal = true;
        unsubscribe();
        this.onJsOwner(`bridge.${request.module}.${request.method}`, () => {
          if (!response.ok) {
            reject(new NativeBridgeError('native-failure'));
            return;
          }
          if (!descriptor.validateResponse(response.payload)) {
            reject(new NativeBridgeError('invalid-response'));
            return;
          }
          resolve(response.payload);
        }, reject);
      };
      const cancel = (): void => {
        if (terminal) return;
        terminal = true;
        if (invocation === undefined) cancelPending = true;
        else invocation.cancel();
        unsubscribe();
        this.onJsOwner(`bridge.${request.module}.${request.method}.cancel`, () => {
          reject(new NativeBridgeError('cancelled'));
        }, reject);
      };
      unsubscribe = cancellation?.subscribe(cancel) ?? unsubscribe;
      if (terminal) return;
      try {
        invocation = this.options.port.invoke(request, settle);
        if (cancelPending) invocation.cancel();
      } catch {
        terminal = true;
        unsubscribe();
        this.onJsOwner(`bridge.${request.module}.${request.method}.invoke`, () => {
          reject(new NativeBridgeError('native-failure'));
        }, reject);
      }
    });
  }

  private onJsOwner(operation: string, run: () => void, reject: (reason: unknown) => void): void {
    void this.options.runtime.runOnJsThread(operation, run).catch(() => {
      reject(new NativeBridgeError('runtime-unavailable'));
    });
  }

  private allocateRequestId(): number {
    if (this.nextRequestId === Number.MAX_SAFE_INTEGER) throw new Error('Native bridge request ids exhausted.');
    return this.nextRequestId++;
  }
}

function methodKey(method: Pick<NativeMethodDescriptor<unknown, unknown>, 'module' | 'method'>): string {
  return `${method.module}:${method.method}`;
}

function encodePayload(value: unknown): { readonly bytes: number; readonly payload: unknown } | undefined {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return undefined;
    return {
      bytes: new TextEncoder().encode(text).byteLength,
      payload: freezePayload(JSON.parse(text) as unknown)
    };
  } catch {
    return undefined;
  }
}

function freezePayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const item of value) freezePayload(item);
    return Object.freeze(value);
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) freezePayload(item);
    return Object.freeze(value);
  }
  return value;
}
