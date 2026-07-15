import type {
  DeviceCapabilities,
  FeatureSupport,
  FormatCapabilities,
  QueueCapability,
  RHIFeature,
  RHILimits
} from '../contracts/capability';
import type { RHIBackend } from '../contracts/capability';

export const RHI_FEATURES: readonly RHIFeature[] = Object.freeze([
  'compute',
  'storage-buffer',
  'storage-texture',
  'indirect-draw',
  'timestamp-query'
]);

export interface NullCapabilityProfile {
  readonly features?: Readonly<Partial<Record<RHIFeature, FeatureSupport>>>;
  readonly limits?: RHILimits;
  readonly formats?: ReadonlyMap<string, FormatCapabilities>;
  readonly queues?: readonly QueueCapability[];
}

export interface CapabilitySnapshotInput {
  readonly backend: RHIBackend;
  readonly features: ReadonlyMap<RHIFeature, FeatureSupport>;
  readonly limits: RHILimits;
  readonly formats: ReadonlyMap<string, FormatCapabilities>;
  readonly queues: readonly QueueCapability[];
}

export function createNullCapabilities(
  profile: NullCapabilityProfile = {}
): DeviceCapabilities {
  const features = RHI_FEATURES.map((feature) => {
    const support: FeatureSupport = profile.features?.[feature] ?? {
        status: 'unsupported',
        reason: 'Not configured by the NullAdapter profile.'
      };
    return [feature, support] as const;
  });
  const queues = profile.queues ?? [{ role: 'graphics', status: 'native' } as const];
  return createCapabilitySnapshot({
    backend: 'null',
    features: new Map(features),
    limits: profile.limits ?? {},
    formats: profile.formats ?? new Map(),
    queues
  });
}

export function createCapabilitySnapshot(input: CapabilitySnapshotInput): DeviceCapabilities {
  const features = [...input.features].map(
    ([feature, support]) => [feature, Object.freeze({ ...support })] as const
  );
  const formats = [...input.formats].map(([format, capabilities]) => [
    format,
    Object.freeze({
      ...capabilities,
      sampleCounts: Object.freeze([...capabilities.sampleCounts])
    })
  ] as const);
  return Object.freeze({
    backend: input.backend,
    features: new ReadonlyMapSnapshot(features),
    limits: Object.freeze({ ...input.limits }),
    formats: new ReadonlyMapSnapshot(formats),
    queues: Object.freeze(input.queues.map((queue) => Object.freeze({ ...queue })))
  });
}

export function createNullConformanceCapabilities(): DeviceCapabilities {
  const features = Object.fromEntries(
    RHI_FEATURES.map((feature) => [feature, { status: 'native' as const }])
  ) as Partial<Record<RHIFeature, FeatureSupport>>;
  return createNullCapabilities({ features });
}

class ReadonlyMapSnapshot<K, V> implements ReadonlyMap<K, V> {
  private readonly entriesMap: Map<K, V>;

  constructor(entries: readonly (readonly [K, V])[]) {
    this.entriesMap = new Map(entries);
    Object.freeze(this);
  }

  get size(): number { return this.entriesMap.size; }
  get(key: K): V | undefined { return this.entriesMap.get(key); }
  has(key: K): boolean { return this.entriesMap.has(key); }
  entries(): MapIterator<[K, V]> { return this.entriesMap.entries(); }
  keys(): MapIterator<K> { return this.entriesMap.keys(); }
  values(): MapIterator<V> { return this.entriesMap.values(); }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.entriesMap[Symbol.iterator](); }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.entriesMap.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }
}
