import type { AssetHandle } from '../../types';

/** Immutable CPU payload retained by Asset Runtime for one stable handle. */
export interface AssetPayload<T> {
  readonly version: number;
  readonly contentHash: string;
  readonly value: T;
  readonly dependencies: readonly AssetHandle<unknown>[];
}

/** Caller input copied into an owned payload when a validated revision is published. */
export interface AssetPayloadInput<T> {
  readonly version: number;
  readonly contentHash: string;
  readonly value: T;
  readonly dependencies: readonly AssetHandle<unknown>[];
}

/** CPU availability remains independent from renderer-owned GPU prepared variants. */
export type AssetPayloadAvailability =
  Readonly<{ kind: 'unloaded' }> | Readonly<{ kind: 'published'; version: number }>;

/** Result of resolving a handle against the current CPU payload snapshot. */
export type AssetPayloadResolveResult<T> =
  | Readonly<{ kind: 'available'; payload: AssetPayload<T> }>
  | Readonly<{ kind: 'unavailable'; availability: AssetPayloadAvailability }>;
