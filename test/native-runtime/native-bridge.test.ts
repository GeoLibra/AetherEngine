import { describe, expect, test } from 'vitest';

import {
  NativeBridgeDispatcher,
  NativeBridgeError,
  NativeCancellationSource,
  NativeEventPump,
  NativeRuntimeController,
  NativeThreadContractError,
  type JsRuntimePort,
  type NativeBridgePort,
  type NativeBridgeRequest,
  type NativeBridgeResponse,
  type NativeMethodDescriptor,
  type NativeNegotiatedHandshake,
  type NativeThreadPort
} from '../../src';

class Runtime implements JsRuntimePort {
  readonly id = 'runtime';
  checkpointMicrotasks(): void {}
  destroy(): void {}
}

class Threads implements NativeThreadPort {
  readonly jsThread = 'js';
  current = 'native';
  readonly queued: Array<() => void> = [];
  currentThread(): string { return this.current; }
  dispatchToJs(operation: () => void): void { this.queued.push(operation); }
  drain(): void {
    this.current = this.jsThread;
    for (const operation of this.queued.splice(0)) operation();
  }
}

interface EchoRequest { readonly text: string }
interface EchoResponse { readonly echoed: string }

const ECHO: NativeMethodDescriptor<EchoRequest, EchoResponse> = Object.freeze({
  module: 'filesystem',
  method: 'echo',
  version: 2,
  maxRequestBytes: 64,
  validateRequest: (value: unknown): value is EchoRequest =>
    typeof value === 'object' && value !== null && typeof (value as { text?: unknown }).text === 'string',
  validateResponse: (value: unknown): value is EchoResponse =>
    typeof value === 'object' && value !== null && typeof (value as { echoed?: unknown }).echoed === 'string'
});

const HANDSHAKE: NativeNegotiatedHandshake = Object.freeze({
  buildId: 'test',
  engineAbiVersion: 1,
  rhiContractVersion: 1,
  modules: Object.freeze([{ name: 'filesystem', version: 2 }]),
  abi: Object.freeze({
    endianness: 'little', pointerBits: 64,
    arrayBuffer: Object.freeze({ transfer: true, mapped: false, shared: false })
  })
});

class BridgePort implements NativeBridgePort {
  readonly requests: NativeBridgeRequest[] = [];
  readonly cancelled: number[] = [];
  readonly completions = new Map<number, (response: NativeBridgeResponse) => void>();

  invoke(request: NativeBridgeRequest, complete: (response: NativeBridgeResponse) => void) {
    this.requests.push(request);
    this.completions.set(request.id, complete);
    return { cancel: () => { this.cancelled.push(request.id); } };
  }

  complete(response: NativeBridgeResponse): void { this.completions.get(response.id)?.(response); }
}

function setup(methods: readonly NativeMethodDescriptor<unknown, unknown>[] = [ECHO]) {
  const threads = new Threads();
  const runtime = new NativeRuntimeController({ ownership: 'embedded', threads, runtime: new Runtime() });
  const port = new BridgePort();
  const bridge = new NativeBridgeDispatcher({ handshake: HANDSHAKE, runtime, port, methods });
  return { bridge, port, runtime, threads };
}

describe('NativeBridgeDispatcher', () => {
  test('validates registered module, method, request schema, and request size', async () => {
    const { bridge } = setup();
    await expect(bridge.call(ECHO, { text: 42 } as never)).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(bridge.call(ECHO, { text: 'x'.repeat(100) })).rejects.toMatchObject({ code: 'request-too-large' });

    const unknown = { ...ECHO, method: 'missing' };
    await expect(bridge.call(unknown, { text: 'ok' })).rejects.toMatchObject({ code: 'unknown-method' });
    expect(() => setup([{ ...ECHO, module: 'rhi' }])).toThrow(/reserved/i);
    expect(() => setup([{ ...ECHO, module: 'audio' }])).toThrow(/module/i);
    expect(() => setup([{ ...ECHO, version: 3 }])).toThrow(/version/i);
  });

  test('settles success only after completion crosses to the JS owner', async () => {
    const { bridge, port, threads } = setup();
    const payload = { text: 'hello' };
    const result = bridge.call(ECHO, payload);
    const request = port.requests[0]!;

    payload.text = 'mutated';
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.payload)).toBe(true);
    expect(request.payload).toEqual({ text: 'hello' });
    const response = { id: request.id, ok: true as const, payload: { echoed: 'hello' } };
    port.complete(response);
    response.payload.echoed = 'mutated by native';
    let settled = false;
    void result.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    threads.drain();
    await expect(result).resolves.toEqual({ echoed: 'hello' });
  });

  test('redacts native failures and invalid response payloads', async () => {
    const failure = setup();
    const failed = failure.bridge.call(ECHO, { text: 'hello' });
    const failedId = failure.port.requests[0]!.id;
    failure.port.complete({ id: failedId, ok: false, code: 'EIO', detail: 'secret/native/path' });
    failure.threads.drain();
    await expect(failed).rejects.toMatchObject({ code: 'native-failure' });
    await failed.catch((error: unknown) => {
      expect(error).toBeInstanceOf(NativeBridgeError);
      expect(String(error)).not.toContain('secret/native/path');
    });

    const invalid = setup();
    const invalidResult = invalid.bridge.call(ECHO, { text: 'hello' });
    const invalidId = invalid.port.requests[0]!.id;
    invalid.port.complete({ id: invalidId, ok: true, payload: { wrong: true } });
    invalid.threads.drain();
    await expect(invalidResult).rejects.toMatchObject({ code: 'invalid-response' });
  });

  test('propagates cancellation once and suppresses late completion', async () => {
    const { bridge, port, threads } = setup();
    const cancellation = new NativeCancellationSource();
    const result = bridge.call(ECHO, { text: 'hello' }, cancellation.token);
    const id = port.requests[0]!.id;

    expect(cancellation.cancel()).toBe(true);
    expect(cancellation.cancel()).toBe(false);
    expect(port.cancelled).toEqual([id]);
    port.complete({ id, ok: true, payload: { echoed: 'late' } });
    threads.drain();
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
    expect(port.cancelled).toEqual([id]);
  });
});

describe('NativeEventPump', () => {
  test('queues callbacks from any thread and drains FIFO only on the JS owner', () => {
    const { runtime, threads } = setup();
    const pump = new NativeEventPump(runtime, 4);
    const calls: number[] = [];
    pump.enqueue(() => calls.push(1));
    pump.enqueue(() => calls.push(2));

    expect(calls).toEqual([]);
    expect(() => pump.drain()).toThrow(NativeThreadContractError);
    threads.current = threads.jsThread;
    expect(pump.drain()).toBe(2);
    expect(calls).toEqual([1, 2]);
  });

  test('defers callbacks added during a drain and bounds queue growth', () => {
    const { runtime, threads } = setup();
    threads.current = threads.jsThread;
    const pump = new NativeEventPump(runtime, 2);
    const calls: number[] = [];
    pump.enqueue(() => { calls.push(1); pump.enqueue(() => calls.push(3)); });
    pump.enqueue(() => calls.push(2));

    expect(pump.enqueue(() => calls.push(99))).toBe(false);
    expect(pump.drain()).toBe(2);
    expect(calls).toEqual([1, 2]);
    expect(pump.size).toBe(1);
    expect(pump.drain()).toBe(1);
    expect(calls).toEqual([1, 2, 3]);
  });
});
