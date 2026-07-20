export type E2EState =
  | { readonly status: 'booting' }
  | {
      readonly status: 'ready';
      readonly host: 'browser';
      readonly backend: 'browser-host' | 'webgl2';
      readonly detail: Readonly<Record<string, unknown>>;
    }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'destroyed' };

export interface E2EBridge {
  state(): E2EState;
  resize(width: number, height: number, dpr: number): Promise<void>;
  teardown(): Promise<void>;
}

declare global {
  interface Window {
    __AETHER_E2E__: E2EBridge;
  }
}
