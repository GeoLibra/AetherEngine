export function cloneRecord(
  input: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return cloneUnknown(input) as Record<string, unknown>;
}

export function freezeRecord(
  input: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  return freezeUnknown(cloneRecord(input));
}

export function cloneUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneUnknown);
  }
  if (value instanceof ArrayBuffer) {
    return value.slice(0);
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.byteLength);
    bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    if (value instanceof DataView) {
      return new DataView(bytes.buffer);
    }
    const Constructor = value.constructor as unknown as {
      new (buffer: ArrayBuffer): ArrayBufferView;
    };
    return new Constructor(bytes.buffer);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneUnknown(entry)])
    );
  }
  return value;
}

export function freezeUnknown<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(freezeUnknown);
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    Object.values(value).forEach(freezeUnknown);
    return Object.freeze(value);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
