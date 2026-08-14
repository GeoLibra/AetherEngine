import type { NativeRuntimeOwnership } from './manifest-types';

export interface JsRuntimePort {
  readonly id: string;
  checkpointMicrotasks(): void;
  destroy(): void;
}

export interface NativeThreadPort {
  readonly jsThread: string;
  currentThread(): string;
  dispatchToJs(operation: () => void): void;
}

export interface NativeThreadDiagnostic {
  readonly operation: string;
  readonly requiredThread: string;
  readonly actualThread: string;
}

export type NativeRuntimeControllerOptions =
  | {
      readonly ownership: Extract<NativeRuntimeOwnership, 'dedicated'>;
      readonly threads: NativeThreadPort;
      readonly createRuntime: () => JsRuntimePort;
    }
  | {
      readonly ownership: Extract<NativeRuntimeOwnership, 'embedded'>;
      readonly threads: NativeThreadPort;
      readonly runtime: JsRuntimePort;
    };
