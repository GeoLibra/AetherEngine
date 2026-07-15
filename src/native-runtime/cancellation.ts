import type { NativeCancellationToken } from './bridge-types';

export class NativeCancellationSource {
  private cancelledValue = false;
  private readonly listeners = new Set<() => void>();
  readonly token: NativeCancellationToken;

  constructor() {
    const source = this;
    this.token = Object.freeze({
      get cancelled(): boolean { return source.cancelledValue; },
      subscribe(listener: () => void): () => boolean {
        if (source.cancelledValue) {
          listener();
          return () => false;
        }
        source.listeners.add(listener);
        return () => source.listeners.delete(listener);
      }
    });
  }

  cancel(): boolean {
    if (this.cancelledValue) return false;
    this.cancelledValue = true;
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const listener of listeners) listener();
    return true;
  }
}
