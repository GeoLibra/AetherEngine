import type {
  AdapterCapabilities,
  FeatureSupport,
  RHIFeature
} from '../contracts/capability';
import { createCapabilitySnapshot, RHI_FEATURES } from '../core/capabilities';
import type { WebGL2AdapterFacts, WebGL2NativeContextPort } from './native-types';

const TIMER_QUERY_EXTENSION = 'EXT_disjoint_timer_query_webgl2';

export function createWebGL2Capabilities(native: WebGL2NativeContextPort): AdapterCapabilities {
  const features = new Map<RHIFeature, FeatureSupport>();
  for (const feature of RHI_FEATURES) {
    if (feature === 'timestamp-query' && native.extensions.has(TIMER_QUERY_EXTENSION)) {
      features.set(feature, { status: 'native' });
      continue;
    }
    features.set(feature, {
      status: 'unsupported',
      reason: unsupportedFeatureReason(feature)
    });
  }
  return createCapabilitySnapshot({
    backend: 'webgl2',
    features,
    limits: native.limits,
    formats: native.formats,
    queues: Object.freeze([Object.freeze({ role: 'graphics' as const, status: 'native' as const })])
  });
}

export function createWebGL2Facts(native: WebGL2NativeContextPort): WebGL2AdapterFacts {
  return Object.freeze({
    extensions: new ReadonlySetSnapshot(native.extensions),
    precision: Object.freeze({ ...native.precision })
  });
}

function unsupportedFeatureReason(feature: RHIFeature): string {
  if (feature === 'timestamp-query') return `WebGL2 extension ${TIMER_QUERY_EXTENSION} is unavailable.`;
  return `Portable RHI feature ${feature} is not provided by the WebGL2 backend.`;
}

class ReadonlySetSnapshot<T> implements ReadonlySet<T> {
  private readonly valuesSet: Set<T>;

  constructor(values: Iterable<T>) {
    this.valuesSet = new Set(values);
    Object.freeze(this);
  }

  get size(): number { return this.valuesSet.size; }
  has(value: T): boolean { return this.valuesSet.has(value); }
  entries(): SetIterator<[T, T]> { return this.valuesSet.entries(); }
  keys(): SetIterator<T> { return this.valuesSet.keys(); }
  values(): SetIterator<T> { return this.valuesSet.values(); }
  [Symbol.iterator](): SetIterator<T> { return this.valuesSet[Symbol.iterator](); }
  forEach(callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    this.valuesSet.forEach((value) => callbackfn.call(thisArg, value, value, this));
  }
}
