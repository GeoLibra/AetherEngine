import { describe, expect, test } from 'vitest';

import {
  NativeRuntimeController,
  NativeRuntimeOperationError,
  NativeThreadContractError,
  type JsRuntimePort,
  type NativeThreadPort
} from '../../src';

class Runtime implements JsRuntimePort {
  readonly id = 'runtime';
  checkpoints = 0;
  destroys = 0;
  checkpointMicrotasks(): void { this.checkpoints += 1; }
  destroy(): void { this.destroys += 1; }
}

class Threads implements NativeThreadPort {
  readonly jsThread = 'js';
  current = 'native';
  readonly queued: Array<() => void> = [];
  currentThread(): string { return this.current; }
  dispatchToJs(operation: () => void): void { this.queued.push(operation); }
  drain(): void {
    this.current = this.jsThread;
    const queued = this.queued.splice(0);
    for (const operation of queued) operation();
  }
}

describe('Native runtime ownership and threads', () => {
  test('creates and owns one runtime for a dedicated target', () => {
    const threads = new Threads();
    const runtime = new Runtime();
    let creations = 0;
    const controller = new NativeRuntimeController({
      ownership: 'dedicated', threads,
      createRuntime: () => { creations += 1; return runtime; }
    });

    expect(controller.runtime).toBe(runtime);
    expect(controller.runtime).toBe(runtime);
    expect(creations).toBe(1);
    controller.destroy();
    controller.destroy();
    expect(runtime.destroys).toBe(1);
  });

  test('adopts but never creates or destroys an embedded runtime', () => {
    const threads = new Threads();
    const runtime = new Runtime();
    const controller = new NativeRuntimeController({
      ownership: 'embedded', threads, runtime
    });

    expect(controller.runtime).toBe(runtime);
    controller.destroy();
    expect(runtime.destroys).toBe(0);
  });

  test('rejects wrong-thread direct entry with immutable diagnostics', () => {
    const threads = new Threads();
    const controller = new NativeRuntimeController({
      ownership: 'embedded', threads, runtime: new Runtime()
    });

    let error: unknown;
    try {
      controller.enterJsThread('native.callback', () => undefined);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(NativeThreadContractError);
    expect((error as NativeThreadContractError).diagnostic).toEqual({
      operation: 'native.callback', requiredThread: 'js', actualThread: 'native'
    });
    expect(Object.isFrozen((error as NativeThreadContractError).diagnostic)).toBe(true);
  });

  test('marshals work to the JS owner in FIFO order', async () => {
    const threads = new Threads();
    const controller = new NativeRuntimeController({
      ownership: 'embedded', threads, runtime: new Runtime()
    });
    const calls: number[] = [];

    const first = controller.runOnJsThread('first', () => { calls.push(1); return 'one'; });
    const second = controller.runOnJsThread('second', () => { calls.push(2); return 'two'; });
    expect(calls).toEqual([]);
    expect(threads.queued).toHaveLength(2);

    threads.drain();
    await expect(Promise.all([first, second])).resolves.toEqual(['one', 'two']);
    expect(calls).toEqual([1, 2]);
  });

  test('checkpoints only on the JS thread and wraps operation failure context', async () => {
    const threads = new Threads();
    const runtime = new Runtime();
    const controller = new NativeRuntimeController({ ownership: 'embedded', threads, runtime });

    expect(() => controller.checkpointMicrotasks()).toThrow(NativeThreadContractError);
    const failure = controller.runOnJsThread('module.load', () => { throw new Error('native detail'); });
    threads.drain();
    await expect(failure).rejects.toMatchObject({
      name: 'NativeRuntimeOperationError', operation: 'module.load', cause: expect.any(Error)
    });
    await failure.catch((error: unknown) => {
      expect(error).toBeInstanceOf(NativeRuntimeOperationError);
      expect(String(error)).not.toContain('native detail');
    });
    controller.checkpointMicrotasks();
    expect(runtime.checkpoints).toBe(1);
  });

  test('suppresses queued JS work when destruction wins the dispatch race', async () => {
    const threads = new Threads();
    const controller = new NativeRuntimeController({
      ownership: 'embedded', threads, runtime: new Runtime()
    });
    let calls = 0;
    const pending = controller.runOnJsThread('late.callback', () => { calls += 1; });

    controller.destroy();
    threads.drain();

    await expect(pending).rejects.toMatchObject({ name: 'NativeRuntimeOperationError' });
    expect(calls).toBe(0);
  });
});
