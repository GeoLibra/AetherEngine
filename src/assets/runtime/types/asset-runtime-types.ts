import type { AssetHandle } from '../../types';

/** Immutable CPU payload retained by Asset Runtime for one stable handle. */
export interface AssetPayload<T> {
  /** Monotonically increasing revision number for this stable asset handle. */
  readonly version: number;
  /** Content-addressed identity for the immutable CPU payload. */
  readonly contentHash: string;
  /** Owned CPU payload footprint in bytes, as measured by its format adapter. */
  readonly byteLength: number;
  /** Deeply immutable canonical CPU representation. */
  readonly value: T;
  /** Typed asset references required to make this payload usable. */
  readonly dependencies: readonly AssetHandle<unknown>[];
}

/** Caller input copied into an owned payload when a validated revision is published. */
export interface AssetPayloadInput<T> {
  /** Monotonically increasing revision number for this stable asset handle. */
  readonly version: number;
  /** Content-addressed identity for the immutable CPU payload. */
  readonly contentHash: string;
  /** Measured owned CPU footprint in bytes; does not include GPU variants. */
  readonly byteLength: number;
  /** Caller-owned canonical input copied by the registered format adapter. */
  readonly value: T;
  /** Typed asset references required to make this payload usable. */
  readonly dependencies: readonly AssetHandle<unknown>[];
}

/** CPU availability remains independent from renderer-owned GPU prepared variants. */
export type AssetPayloadAvailability =
  Readonly<{ kind: 'unloaded' }> | Readonly<{ kind: 'published'; version: number }>;

/** Result of resolving a handle against the current CPU payload snapshot. */
export type AssetPayloadResolveResult<T> =
  | Readonly<{ kind: 'available'; payload: AssetPayload<T> }>
  | Readonly<{ kind: 'unavailable'; availability: AssetPayloadAvailability }>;

/** Pins one CPU payload revision until released; release is idempotent. */
export interface AssetPayloadLease<T> {
  readonly payload: AssetPayload<T>;
  dispose(): void;
}

/** Result of trying to evict the current CPU payload revision. */
export type AssetPayloadEvictionResult =
  | Readonly<{ kind: 'evicted'; version: number; bytes: number }>
  | Readonly<{ kind: 'not-resident' }>
  | Readonly<{ kind: 'leased'; version: number; leaseCount: number }>;
