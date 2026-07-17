import type { RHISubmission } from '../rhi';

export interface PreparedVariantKey {
  readonly assetId: string;
  readonly payloadVersion: number;
  readonly deviceGeneration: number;
  readonly featurePolicyKey: string;
  readonly abiVersion: string;
}
export interface PreparedAsset<T> {
  readonly key: PreparedVariantKey;
  readonly value: T;
}
export interface PreparedAssetLease<T> {
  readonly prepared: PreparedAsset<T>;
  readonly disposed: boolean;
  retainUntil(submission: RHISubmission): void;
  dispose(): void;
}

interface Entry<T> {
  readonly prepared: PreparedAsset<T>;
  readonly destroy: (value: T) => void;
  leases: number;
  submissions: number;
  retired: boolean;
  destroyed: boolean;
}

export class PreparedAssetRegistry {
  private readonly entries = new Map<string, Entry<unknown>>();

  publish<T>(prepared: PreparedAsset<T>, destroy: (value: T) => void = () => undefined): void {
    const id = preparedKey(prepared.key);
    if (this.entries.has(id)) throw new Error(`Prepared asset variant already exists: ${id}`);
    this.entries.set(id, {
      prepared: deepFreezePrepared(prepared),
      destroy: destroy as (value: unknown) => void,
      leases: 0,
      submissions: 0,
      retired: false,
      destroyed: false
    });
  }

  acquire<T>(key: PreparedVariantKey): PreparedAssetLease<T> | undefined {
    const entry = this.entries.get(preparedKey(key)) as Entry<T> | undefined;
    if (!entry || entry.retired) return undefined;
    entry.leases++;
    let disposed = false;
    const registry = this;
    return Object.freeze({
      prepared: entry.prepared,
      get disposed() {
        return disposed;
      },
      retainUntil(submission: RHISubmission) {
        if (disposed) throw new Error('Cannot retain a disposed prepared asset lease.');
        entry.submissions++;
        void submission.done.finally(() => {
          entry.submissions--;
          registry.collect(entry, preparedKey(key));
        });
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        entry.leases--;
        registry.collect(entry, preparedKey(key));
      }
    });
  }

  retire(key: PreparedVariantKey): void {
    const id = preparedKey(key);
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.retired = true;
    this.collect(entry, id);
  }

  invalidateDevice(deviceGeneration: number): void {
    for (const [id, entry] of this.entries)
      if (entry.prepared.key.deviceGeneration === deviceGeneration) {
        entry.retired = true;
        this.collect(entry, id);
      }
  }

  private collect<T>(entry: Entry<T>, id: string): void {
    if (!entry.retired || entry.leases > 0 || entry.submissions > 0 || entry.destroyed) return;
    entry.destroyed = true;
    this.entries.delete(id);
    entry.destroy(entry.prepared.value);
  }
}

export function preparedKey(key: PreparedVariantKey): string {
  return [
    key.assetId,
    key.payloadVersion,
    key.deviceGeneration,
    key.featurePolicyKey,
    key.abiVersion
  ].join('|');
}

function deepFreezePrepared<T>(prepared: PreparedAsset<T>): PreparedAsset<T> {
  return Object.freeze({ key: Object.freeze({ ...prepared.key }), value: prepared.value });
}
