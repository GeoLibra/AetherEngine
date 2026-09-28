import { validateAssetHandle } from '../asset-handle';
import type { AssetHandle } from '../types';
import type {
  AssetPayload,
  AssetPayloadAvailability,
  AssetPayloadEvictionResult,
  AssetPayloadInput,
  AssetPayloadLease,
  AssetPayloadResolveResult
} from './types';

interface AssetRecord {
  readonly handle: AssetHandle<unknown>;
  currentVersion?: number;
  latestPublishedVersion: number;
  readonly revisions: Map<number, { readonly payload: AssetPayload<unknown>; leases: number }>;
}

/** Hard CPU-payload residency limit owned by this registry. */
export interface AssetPayloadRegistryOptions {
  /** Maximum number of bytes retained across current and leased CPU revisions. */
  readonly cpuResidentByteBudget: number;
}

/**
 * Owns stable asset registrations and immutable CPU payload revisions.
 * GPU variants remain owned by Renderer/PreparedAssetRegistry.
 */
export class AssetPayloadRegistry {
  private readonly records = new Map<string, AssetRecord>();

  private residentBytesValue = 0;

  private readonly cpuResidentByteBudget: number;

  /**
   * Creates a CPU payload registry with an explicit resident-byte ceiling.
   *
   * @throws If the configured budget is not a non-negative safe integer.
   */
  constructor(
    options: AssetPayloadRegistryOptions = { cpuResidentByteBudget: Number.MAX_SAFE_INTEGER }
  ) {
    if (!Number.isSafeInteger(options.cpuResidentByteBudget) || options.cpuResidentByteBudget < 0) {
      throw new Error('CPU resident byte budget must be a non-negative safe integer.');
    }
    this.cpuResidentByteBudget = options.cpuResidentByteBudget;
  }

  /** Returns the total bytes of payload revisions still owned by this registry. */
  get residentBytes(): number {
    return this.residentBytesValue;
  }

  /** Registers a stable typed handle before requests or payload publication. */
  register<T>(handle: AssetHandle<T>): void {
    const ownedHandle = validateAssetHandle(handle, handle.type);
    const current = this.records.get(ownedHandle.assetId);
    if (current !== undefined) {
      if (current.handle.type !== ownedHandle.type) {
        throw new Error(`Asset "${ownedHandle.assetId}" is registered with another type.`);
      }
      return;
    }
    this.records.set(ownedHandle.assetId, {
      handle: ownedHandle,
      latestPublishedVersion: 0,
      revisions: new Map()
    });
  }

  /** Returns CPU payload availability without claiming GPU residency. */
  availability<T>(handle: AssetHandle<T>): AssetPayloadAvailability {
    const record = this.findRecord(handle);
    const payload =
      record?.currentVersion === undefined
        ? undefined
        : record.revisions.get(record.currentVersion)?.payload;
    return payload === undefined
      ? Object.freeze({ kind: 'unloaded' })
      : Object.freeze({ kind: 'published', version: payload.version });
  }

  /** Resolves the current immutable CPU payload or an explicit unloaded result. */
  resolve<T>(handle: AssetHandle<T>): AssetPayloadResolveResult<T> {
    const record = this.findRecord(handle);
    const payload =
      record?.currentVersion === undefined
        ? undefined
        : (record.revisions.get(record.currentVersion)?.payload as AssetPayload<T> | undefined);
    if (payload !== undefined) return Object.freeze({ kind: 'available', payload });
    return Object.freeze({
      kind: 'unavailable',
      availability: Object.freeze({ kind: 'unloaded' })
    });
  }

  /**
   * Publishes a newer CPU payload only after cloning caller-owned data and dependencies.
   * The clone callback must return a deep, independently owned immutable payload representation.
   *
   * @throws If the handle is unregistered, the revision is invalid/stale, or cloning fails.
   */
  publish<T>(
    handle: AssetHandle<T>,
    input: AssetPayloadInput<T>,
    clonePayload: (value: T) => T
  ): AssetPayload<T> {
    if (typeof input !== 'object' || input === null || !Array.isArray(input.dependencies)) {
      throw new Error('Asset payload input must include a dependency handle array.');
    }
    const record = this.findRecord(handle);
    if (record === undefined) throw new Error(`Asset "${handle.assetId}" is not registered.`);
    if (!Number.isSafeInteger(input.version) || input.version < 1) {
      throw new Error('Asset payload version must be a positive safe integer.');
    }
    if (typeof input.contentHash !== 'string' || !input.contentHash.trim()) {
      throw new Error('Asset payload content hash must be non-empty.');
    }
    if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) {
      throw new Error('Asset payload byte length must be a non-negative safe integer.');
    }
    if (typeof clonePayload !== 'function') {
      throw new Error('Asset payload publication requires an ownership-copy function.');
    }
    if (input.version <= record.latestPublishedVersion) {
      throw new Error(
        `Asset payload version ${input.version} is not newer than the published version.`
      );
    }

    const reclaimable = [...record.revisions.values()]
      .filter((revision) => revision.leases === 0)
      .reduce((bytes, revision) => bytes + revision.payload.byteLength, 0);
    if (this.residentBytesValue - reclaimable + input.byteLength > this.cpuResidentByteBudget) {
      throw new Error('Asset CPU payload publication exceeds the resident byte budget.');
    }
    const value = clonePayload(input.value);
    if (isObjectLike(input.value) && value === input.value) {
      throw new Error('Asset payload clone must not retain the caller-owned top-level object.');
    }
    const dependencies = Object.freeze(input.dependencies.map(copyDependencyHandle));
    const payload = Object.freeze({
      version: input.version,
      contentHash: input.contentHash,
      byteLength: input.byteLength,
      value,
      dependencies
    });
    for (const [version, revision] of record.revisions) {
      if (revision.leases === 0) this.removeRevision(record, version);
    }
    record.revisions.set(input.version, { payload, leases: 0 });
    record.currentVersion = input.version;
    record.latestPublishedVersion = input.version;
    this.residentBytesValue += input.byteLength;
    return payload;
  }

  /** Pins the current CPU revision, preserving it across later publications. */
  acquire<T>(handle: AssetHandle<T>): AssetPayloadLease<T> | undefined {
    const record = this.findRecord(handle);
    if (record?.currentVersion === undefined) return undefined;
    const revision = record.revisions.get(record.currentVersion);
    if (revision === undefined) throw new Error('Current asset payload revision is missing.');
    revision.leases++;
    let released = false;
    return Object.freeze({
      payload: revision.payload as AssetPayload<T>,
      dispose: () => {
        if (released) return;
        released = true;
        revision.leases--;
        if (revision.leases < 0) throw new Error('Asset payload lease count became negative.');
        if (record.currentVersion !== revision.payload.version && revision.leases === 0) {
          this.removeRevision(record, revision.payload.version);
        }
      }
    });
  }

  /** Evicts the current CPU revision only when no consumer lease pins it. */
  evict<T>(handle: AssetHandle<T>): AssetPayloadEvictionResult {
    const record = this.findRecord(handle);
    if (record?.currentVersion === undefined) return Object.freeze({ kind: 'not-resident' });
    const revision = record.revisions.get(record.currentVersion);
    if (revision === undefined) throw new Error('Current asset payload revision is missing.');
    if (revision.leases > 0) {
      return Object.freeze({
        kind: 'leased',
        version: revision.payload.version,
        leaseCount: revision.leases
      });
    }
    const { version, byteLength } = revision.payload;
    this.removeRevision(record, version);
    delete record.currentVersion;
    return Object.freeze({ kind: 'evicted', version, bytes: byteLength });
  }

  private removeRevision(record: AssetRecord, version: number): void {
    const revision = record.revisions.get(version);
    if (revision === undefined) {
      throw new Error('Asset payload revision is missing during reclamation.');
    }
    record.revisions.delete(version);
    this.residentBytesValue -= revision.payload.byteLength;
    if (this.residentBytesValue < 0)
      throw new Error('Asset resident byte accounting became negative.');
  }

  private findRecord<T>(handle: AssetHandle<T>): AssetRecord | undefined {
    const validated = validateAssetHandle(handle, handle.type);
    const record = this.records.get(validated.assetId);
    if (record !== undefined && record.handle.type !== validated.type) {
      throw new Error(`Asset "${validated.assetId}" handle type does not match its registration.`);
    }
    return record;
  }
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function copyDependencyHandle(handle: AssetHandle<unknown>): AssetHandle<unknown> {
  if (
    typeof handle !== 'object' ||
    handle === null ||
    typeof handle.assetId !== 'string' ||
    typeof handle.type !== 'string'
  ) {
    throw new Error('Asset payload dependency must be a typed asset handle.');
  }
  return validateAssetHandle(handle, handle.type, 'Asset dependency');
}
