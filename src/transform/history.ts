import type { HistoryResetReason } from './types';

interface HistoryState {
  reason?: HistoryResetReason;
  version: number;
}

const histories = new WeakMap<TransformHistory, HistoryState>();

export class TransformHistory {
  constructor() {
    histories.set(this, { version: 0 });
  }

  get reason(): HistoryResetReason | undefined {
    return requireHistory(this).reason;
  }

  get version(): number {
    return requireHistory(this).version;
  }

  clear(): void {
    delete requireHistory(this).reason;
  }
}

/** TransformRuntime-only mutation seam; intentionally omitted from the package barrel. */
export function markTransformHistory(
  history: TransformHistory,
  reason: HistoryResetReason
): void {
  const state = requireHistory(history);
  state.reason = reason;
  state.version = (state.version + 1) >>> 0;
}

function requireHistory(history: TransformHistory): HistoryState {
  const state = histories.get(history);
  if (!state) {
    throw new Error('TransformHistory was not initialized by its constructor.');
  }
  return state;
}
