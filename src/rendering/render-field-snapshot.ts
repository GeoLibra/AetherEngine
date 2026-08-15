type TrustedTypedArrayConstructor = new (length: number) => ArrayBufferView;

const TYPED_ARRAY_CONSTRUCTORS = new Map<string, TrustedTypedArrayConstructor>([
  ['Int8Array', Int8Array],
  ['Uint8Array', Uint8Array],
  ['Uint8ClampedArray', Uint8ClampedArray],
  ['Int16Array', Int16Array],
  ['Uint16Array', Uint16Array],
  ['Int32Array', Int32Array],
  ['Uint32Array', Uint32Array],
  ['Float32Array', Float32Array],
  ['Float64Array', Float64Array],
  ['BigInt64Array', BigInt64Array],
  ['BigUint64Array', BigUint64Array]
]);
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_TAG = (() => {
  const getter = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag)?.get;
  if (getter === undefined) {
    throw new Error('The JavaScript runtime does not expose the intrinsic typed-array tag getter.');
  }
  return getter;
})();
const TYPED_ARRAY_LENGTH = (() => {
  const getter = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'length')?.get;
  if (getter === undefined) {
    throw new Error(
      'The JavaScript runtime does not expose the intrinsic typed-array length getter.'
    );
  }
  return getter;
})();
const TYPED_ARRAY_SET = Uint8Array.prototype.set;

/**
 * RenderWorld retains only detached value data. Typed arrays are copied but cannot be frozen by
 * JavaScript; public reads receive a further detached copy so their mutable elements never affect
 * a retained revision.
 */
export function snapshotRenderFieldValue(value: unknown): unknown {
  return copyRenderFieldValue(value);
}

export function copyRenderFieldValue(value: unknown): unknown {
  return copyValue(value, new WeakSet<object>());
}

function copyValue(value: unknown, visiting: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === 'boolean' || type === 'number' || type === 'string') return value;
  if (type === 'bigint' || type === 'function' || type === 'symbol') {
    throw new Error(`Render field values cannot contain ${type} values.`);
  }
  if (type !== 'object') throw new Error('Render field value is unsupported.');
  if (
    value instanceof Map ||
    value instanceof Set ||
    value instanceof WeakMap ||
    value instanceof WeakSet
  ) {
    throw new Error('Render field values cannot contain mutable Map or Set collections.');
  }
  if (ArrayBuffer.isView(value)) return copyTypedArray(value);
  if (hasTypedArrayPrototype(value)) {
    throw new Error('Render field typed-array values must be genuine, non-proxy typed arrays.');
  }
  if (visiting.has(value)) throw new Error('Render field values cannot contain cycles.');
  visiting.add(value);
  try {
    return Array.isArray(value) ? copyArray(value, visiting) : copyRecord(value, visiting);
  } finally {
    visiting.delete(value);
  }
}

function copyTypedArray(value: ArrayBufferView): ArrayBufferView {
  const tag = TYPED_ARRAY_TAG.call(value);
  const constructor = TYPED_ARRAY_CONSTRUCTORS.get(tag);
  if (constructor === undefined) {
    throw new Error('Render field values must contain a supported typed-array value.');
  }
  try {
    // Never consult caller-controlled `constructor`, `from`, iterators, or element accessors.
    // The intrinsic getter/setter validate the typed-array internal slots and copy into a normal,
    // detached ArrayBuffer even when the input uses SharedArrayBuffer backing storage.
    const copy = new constructor(TYPED_ARRAY_LENGTH.call(value));
    Reflect.apply(TYPED_ARRAY_SET, copy, [value]);
    return copy;
  } catch {
    throw new Error('Render field typed-array values must be genuine, supported typed arrays.');
  }
}

function hasTypedArrayPrototype(value: object): boolean {
  let prototype = Object.getPrototypeOf(value);
  while (prototype !== null) {
    if (prototype === TYPED_ARRAY_PROTOTYPE) return true;
    prototype = Object.getPrototypeOf(prototype);
  }
  return false;
}

function copyArray(value: readonly unknown[], visiting: WeakSet<object>): readonly unknown[] {
  const copy = new Array<unknown>(value.length);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol')
      throw new Error('Render field arrays cannot contain symbol properties.');
    if (key === 'length') continue;
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key) {
      throw new Error('Render field arrays cannot contain named properties.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
      throw new Error('Render field values must contain data properties only.');
    }
    copy[index] = copyValue(descriptor?.value, visiting);
  }
  return Object.freeze(copy);
}

function copyRecord(value: object, visiting: WeakSet<object>): Readonly<Record<string, unknown>> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Render field values must be plain or null-prototype records.');
  }
  const copy = Object.create(prototype) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol')
      throw new Error('Render field records cannot contain symbol properties.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
      throw new Error('Render field values must contain data properties only.');
    }
    Object.defineProperty(copy, key, {
      configurable: false,
      enumerable: descriptor?.enumerable ?? true,
      value: copyValue(descriptor?.value, visiting),
      writable: false
    });
  }
  return Object.freeze(copy);
}
