import { validateAssetHandle } from '../asset-handle';
import type { AssetHandle } from '../types';
import type {
  AssetPayload,
  AssetPayloadAvailability,
  AssetPayloadInput,
  AssetPayloadResolveResult
} from './types';

interface AssetRecord {
  readonly handle: AssetHandle<unknown>;
  payload?: AssetPayload<unknown>;
}

/**
 * Owns stable asset registrations and immutable CPU payload revisions.
 * GPU variants remain owned by Renderer/PreparedAssetRegistry.
 */
export class AssetPayloadRegistry {
  private readonly records = new Map<string, AssetRecord>();

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
    this.records.set(ownedHandle.assetId, { handle: ownedHandle });
  }

  /** Returns CPU payload availability without claiming GPU residency. */
  availability<T>(handle: AssetHandle<T>): AssetPayloadAvailability {
    const record = this.findRecord(handle);
    const payload = record?.payload;
    return payload === undefined
      ? Object.freeze({ kind: 'unloaded' })
      : Object.freeze({ kind: 'published', version: payload.version });
  }

  /** Resolves the current immutable CPU payload or an explicit unloaded result. */
  resolve<T>(handle: AssetHandle<T>): AssetPayloadResolveResult<T> {
    const record = this.findRecord(handle);
    const payload = record?.payload as AssetPayload<T> | undefined;
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
    if (typeof clonePayload !== 'function') {
      throw new Error('Asset payload publication requires an ownership-copy function.');
    }
    if (record.payload !== undefined && input.version <= record.payload.version) {
      throw new Error(
        `Asset payload version ${input.version} is not newer than the published version.`
      );
    }

    const value = clonePayload(input.value);
    if (isObjectLike(input.value) && value === input.value) {
      throw new Error('Asset payload clone must not retain the caller-owned top-level object.');
    }
    const dependencies = Object.freeze(input.dependencies.map(copyDependencyHandle));
    const payload = Object.freeze({
      version: input.version,
      contentHash: input.contentHash,
      value,
      dependencies
    });
    record.payload = payload;
    return payload;
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
