import type { NativeThreadDiagnostic, NativeThreadPort } from './types';

export class NativeThreadContractError extends Error {
  readonly diagnostic: NativeThreadDiagnostic;

  constructor(diagnostic: NativeThreadDiagnostic) {
    const frozen = Object.freeze({ ...diagnostic });
    super(
      `Native operation "${frozen.operation}" requires thread "${frozen.requiredThread}", ` +
        `actual thread is "${frozen.actualThread}".`
    );
    this.name = 'NativeThreadContractError';
    this.diagnostic = frozen;
  }
}

export function assertNativeJsThread(threads: NativeThreadPort, operation: string): void {
  const actualThread = threads.currentThread();
  if (actualThread === threads.jsThread) return;
  throw new NativeThreadContractError({
    operation,
    requiredThread: threads.jsThread,
    actualThread
  });
}
