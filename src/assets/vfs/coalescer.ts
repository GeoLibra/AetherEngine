import type { VFSTransportKey } from './types';

interface ConsumerRecord {
  readonly id: number;
  readonly signal?: AbortSignal;
  isCancelled: boolean;
}

interface InFlightEntry<TResult> {
  readonly key: VFSTransportKey;
  readonly controller: AbortController;
  readonly consumers: Map<number, ConsumerRecord>;
  readonly promise: Promise<TResult>;
}

/**
 * Coalesces concurrent in-flight transport requests with identical transport keys.
 * Each caller receives an independent cancellation lease. The underlying transport
 * operation is aborted only when the last active consumer lease cancels.
 */
export class VFSInFlightCoalescer<TResult> {
  readonly #inFlight = new Map<VFSTransportKey, InFlightEntry<TResult>>();
  #nextConsumerId = 1;

  /** Active number of deduplicated in-flight transport operations. */
  get activeOperations(): number {
    return this.#inFlight.size;
  }

  /**
   * Executes or joins an in-flight operation for the specified key.
   *
   * @param key Complete transport key.
   * @param signal Caller-provided abort signal for their independent cancellation lease.
   * @param factory Creates the underlying transport promise when starting a new operation.
   * @param cloneResult Optional callback to clone results (e.g. detached byte copies) per consumer.
   */
  async coalesce(
    key: VFSTransportKey,
    signal: AbortSignal | undefined,
    factory: (transportSignal: AbortSignal) => Promise<TResult>,
    cloneResult?: (result: TResult) => TResult
  ): Promise<TResult> {
    if (signal?.aborted) {
      throw new DOMException('Operation aborted by caller lease.', 'AbortError');
    }

    const consumerId = this.#nextConsumerId++;
    const consumer: ConsumerRecord = {
      id: consumerId,
      ...(signal === undefined ? {} : { signal }),
      isCancelled: false
    };

    let entry = this.#inFlight.get(key);
    if (!entry) {
      const controller = new AbortController();
      const consumers = new Map<number, ConsumerRecord>();
      consumers.set(consumerId, consumer);

      const promise = factory(controller.signal).finally(() => {
        this.#inFlight.delete(key);
      });

      entry = { key, controller, consumers, promise };
      this.#inFlight.set(key, entry);
    } else {
      entry.consumers.set(consumerId, consumer);
    }

    const currentEntry = entry;

    return new Promise<TResult>((resolve, reject) => {
      const cleanupSignal = () => {
        if (signal && onAbort) {
          signal.removeEventListener('abort', onAbort);
        }
      };

      const onAbort = () => {
        consumer.isCancelled = true;
        currentEntry.consumers.delete(consumerId);
        cleanupSignal();
        // If all consumers cancelled, abort the underlying transport
        if (currentEntry.consumers.size === 0) {
          currentEntry.controller.abort();
        }
        reject(new DOMException('Operation aborted by caller lease.', 'AbortError'));
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      currentEntry.promise
        .then((result) => {
          cleanupSignal();
          if (consumer.isCancelled) {
            reject(new DOMException('Operation aborted by caller lease.', 'AbortError'));
            return;
          }
          const finalResult = cloneResult ? cloneResult(result) : result;
          resolve(finalResult);
        })
        .catch((error: unknown) => {
          cleanupSignal();
          reject(error);
        });
    });
  }
}
