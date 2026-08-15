import { describe, expect, test } from 'vitest';
import { copyRenderFieldValue } from '../../src/rendering/render-field-snapshot';
import {
  RenderExtractorRegistryBuilder,
  RenderWorld,
  defineExtractorToken,
  defineRenderField,
  type RenderEntityId
} from '../../src/rendering';

type SupportedTypedArray = Exclude<ArrayBufferView, DataView>;

interface TypedArrayCase {
  readonly name: string;
  readonly create: () => SupportedTypedArray;
  readonly expected: readonly number[] | readonly bigint[];
  readonly mutate: (value: SupportedTypedArray) => void;
  readonly intrinsic: (value: unknown) => boolean;
}

const TYPED_ARRAY_CASES: readonly TypedArrayCase[] = [
  {
    name: 'Int8Array',
    create: () => new Int8Array([-2, 3]),
    expected: [-2, 3],
    mutate: (value) => Reflect.set(value, 0, 7),
    intrinsic: (value) => value instanceof Int8Array
  },
  {
    name: 'Uint8Array',
    create: () => new Uint8Array([2, 3]),
    expected: [2, 3],
    mutate: (value) => Reflect.set(value, 0, 7),
    intrinsic: (value) => value instanceof Uint8Array
  },
  {
    name: 'Uint8ClampedArray',
    create: () => new Uint8ClampedArray([2, 3]),
    expected: [2, 3],
    mutate: (value) => Reflect.set(value, 0, 7),
    intrinsic: (value) => value instanceof Uint8ClampedArray
  },
  {
    name: 'Int16Array',
    create: () => new Int16Array([-2, 3]),
    expected: [-2, 3],
    mutate: (value) => Reflect.set(value, 0, 7),
    intrinsic: (value) => value instanceof Int16Array
  },
  {
    name: 'Uint16Array',
    create: () => new Uint16Array([2, 3]),
    expected: [2, 3],
    mutate: (value) => Reflect.set(value, 0, 7),
    intrinsic: (value) => value instanceof Uint16Array
  },
  {
    name: 'Int32Array',
    create: () => new Int32Array([-2, 3]),
    expected: [-2, 3],
    mutate: (value) => Reflect.set(value, 0, 7),
    intrinsic: (value) => value instanceof Int32Array
  },
  {
    name: 'Uint32Array',
    create: () => new Uint32Array([2, 3]),
    expected: [2, 3],
    mutate: (value) => Reflect.set(value, 0, 7),
    intrinsic: (value) => value instanceof Uint32Array
  },
  {
    name: 'Float32Array',
    create: () => new Float32Array([2, 3]),
    expected: [2, 3],
    mutate: (value) => Reflect.set(value, 0, 7),
    intrinsic: (value) => value instanceof Float32Array
  },
  {
    name: 'Float64Array',
    create: () => new Float64Array([2, 3]),
    expected: [2, 3],
    mutate: (value) => Reflect.set(value, 0, 7),
    intrinsic: (value) => value instanceof Float64Array
  },
  {
    name: 'BigInt64Array',
    create: () => new BigInt64Array([-2n, 3n]),
    expected: [-2n, 3n],
    mutate: (value) => Reflect.set(value, 0, 7n),
    intrinsic: (value) => value instanceof BigInt64Array
  },
  {
    name: 'BigUint64Array',
    create: () => new BigUint64Array([2n, 3n]),
    expected: [2n, 3n],
    mutate: (value) => Reflect.set(value, 0, 7n),
    intrinsic: (value) => value instanceof BigUint64Array
  }
];

describe('Render field typed-array snapshots', () => {
  test.each(TYPED_ARRAY_CASES)('copies $name with the trusted intrinsic family', (entry) => {
    const source = entry.create();
    const copy = copyRenderFieldValue(source) as SupportedTypedArray;

    expect(entry.intrinsic(copy)).toBe(true);
    expect(values(copy)).toEqual(entry.expected);
    expect(copy.buffer).not.toBe(source.buffer);
    entry.mutate(source);
    expect(values(copy)).toEqual(entry.expected);
  });

  test('ignores a poisoned own typed-array constructor while copying', () => {
    const source = new Float32Array([1, 2]);
    Object.defineProperty(source, 'constructor', {
      configurable: true,
      value: {
        from: () => {
          throw new Error('poisoned constructor');
        }
      }
    });

    expect(values(copyRenderFieldValue(source) as SupportedTypedArray)).toEqual([1, 2]);
  });

  test('does not let a typed-array subclass choose the published copy constructor', () => {
    class PoisonedFloat32Array extends Float32Array {
      static override from(): PoisonedFloat32Array {
        throw new Error('poisoned subclass constructor');
      }
    }
    const source = new PoisonedFloat32Array([1, 2]);
    const copy = copyRenderFieldValue(source);

    expect(copy).toBeInstanceOf(Float32Array);
    expect(copy).not.toBeInstanceOf(PoisonedFloat32Array);
    expect(values(copy as SupportedTypedArray)).toEqual([1, 2]);
  });

  test('does not trust a spoofed own typed-array toStringTag', () => {
    const source = new Float32Array([1, 2]);
    Object.defineProperty(source, Symbol.toStringTag, { configurable: true, value: 'Uint8Array' });

    const copy = copyRenderFieldValue(source);

    expect(copy).toBeInstanceOf(Float32Array);
    expect(values(copy as SupportedTypedArray)).toEqual([1, 2]);
  });

  test('rejects a proxy instead of consulting proxy-controlled typed-array properties', () => {
    const source = new Proxy(new Uint16Array([1, 2]), {});

    expect(() => copyRenderFieldValue(source)).toThrow(/proxy|typed array/i);
  });

  test('rejects transparent and ownKeys-hiding record proxies at the field boundary', () => {
    const transparent = new Proxy({ nested: { value: 1 } }, {});
    const hidden = new Proxy(
      { nested: new Uint8Array([1]) },
      {
        getPrototypeOf: () => Object.prototype,
        ownKeys: () => [],
        getOwnPropertyDescriptor: () => undefined
      }
    );

    expect(() => copyRenderFieldValue(transparent)).toThrow(/proxy|clone/i);
    expect(() => copyRenderFieldValue(hidden)).toThrow(/proxy|clone/i);
  });

  test('continues to snapshot ordinary plain and null-prototype records without freezing callers', () => {
    const plain = { nested: [1, 2] };
    const nullRecord = Object.assign(Object.create(null), { plain });
    const copy = copyRenderFieldValue(nullRecord) as { plain: { nested: readonly number[] } };

    plain.nested[0] = 9;

    expect(copy.plain.nested).toEqual([1, 2]);
    expect(Object.isExtensible(plain)).toBe(true);
  });

  test('rejects accessor records before a proxy probe can invoke caller code', () => {
    let reads = 0;
    const source = Object.defineProperty({}, 'hidden', {
      enumerable: true,
      get() {
        reads++;
        return 1;
      }
    });

    expect(() => copyRenderFieldValue(source)).toThrow(/data properties/i);
    expect(reads).toBe(0);
  });

  test('rejects nested accessors before the single root proxy probe invokes caller code', () => {
    let reads = 0;
    const source = {
      nested: Object.defineProperty({}, 'hidden', {
        enumerable: true,
        get() {
          reads++;
          return 1;
        }
      })
    };

    expect(() => copyRenderFieldValue(source)).toThrow(/data properties/i);
    expect(reads).toBe(0);
  });

  test('uses the module-captured structuredClone intrinsic after the global is replaced', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone');
    const hostile = new Proxy({ value: 1 }, { ownKeys: () => [] });
    try {
      Object.defineProperty(globalThis, 'structuredClone', {
        configurable: true,
        value: () => ({ accepted: true }),
        writable: true
      });

      expect(() => copyRenderFieldValue(hostile)).toThrow(/proxy|clone/i);
    } finally {
      if (original) Object.defineProperty(globalThis, 'structuredClone', original);
      else Reflect.deleteProperty(globalThis, 'structuredClone');
    }
  });

  test('rejects DataView values instead of treating bytes as a field typed array', () => {
    expect(() => copyRenderFieldValue(new DataView(new ArrayBuffer(8)))).toThrow(/typed-array/i);
  });

  test('detaches a typed-array snapshot from a shared backing buffer', () => {
    const shared = new SharedArrayBuffer(Uint32Array.BYTES_PER_ELEMENT * 2);
    const source = new Uint32Array(shared);
    source.set([3, 4]);
    const copy = copyRenderFieldValue(source) as Uint32Array;

    source[0] = 9;
    expect(copy.buffer).not.toBe(shared);
    expect([...copy]).toEqual([3, 4]);
  });

  test.each(TYPED_ARRAY_CASES)('returns a detached public $name field read', (entry) => {
    const Field = defineRenderField<SupportedTypedArray>(`${entry.name}-field`);
    const owner = defineExtractorToken(`${entry.name}-owner`, [Field]);
    const world = new RenderWorld({
      extractorPlan: new RenderExtractorRegistryBuilder().registerExtractor(owner).build()
    });
    const source = entry.create();
    const transaction = world.beginExtract(1, 0);
    const entity = transaction.mapEntity(`${entry.name}-entity`);
    transaction.draft(owner).upsert(entity, Field, source);
    transaction.commit().release();
    const first = world.read(entity, Field)!;

    entry.mutate(source);
    entry.mutate(first);

    expect(values(world.read(entity, Field)!)).toEqual(entry.expected);
  });
});

function values(value: SupportedTypedArray): readonly unknown[] {
  return Array.from(value as unknown as ArrayLike<unknown>);
}
