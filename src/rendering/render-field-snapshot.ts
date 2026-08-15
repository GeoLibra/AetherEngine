type TypedArrayConstructor = {
  from(values: ArrayLike<unknown>): ArrayBufferView;
};

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
  if (visiting.has(value)) throw new Error('Render field values cannot contain cycles.');
  visiting.add(value);
  try {
    return Array.isArray(value) ? copyArray(value, visiting) : copyRecord(value, visiting);
  } finally {
    visiting.delete(value);
  }
}

function copyTypedArray(value: ArrayBufferView): ArrayBufferView {
  if (value instanceof DataView)
    throw new Error('Render field values cannot contain DataView values.');
  const constructor = value.constructor as unknown as TypedArrayConstructor;
  if (typeof constructor.from !== 'function') {
    throw new Error('Render field typed-array value cannot be copied.');
  }
  return constructor.from(value as unknown as ArrayLike<unknown>);
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
