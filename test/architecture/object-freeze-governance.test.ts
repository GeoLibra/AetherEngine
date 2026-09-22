import {
  analyzeFreezeSource,
  auditProductionFreeze,
  type NestedMutableExposure
} from '../../scripts/object-freeze-analysis.mjs';
import { describe, expect, test } from 'vitest';

interface ReviewedNestedMutableExposure extends NestedMutableExposure {
  readonly rationale: string;
}

/**
 * Every exception needs an exact freeze call, property path, runtime kind, and a review rationale.
 * VFS returns caller-owned detached bytes with frozen metadata, not immutable byte storage.
 * Its ownership and native Buffer isolation are covered by the focused VFS contract tests.
 */
const NESTED_MUTABLE_ALLOWLIST: readonly ReviewedNestedMutableExposure[] = Object.freeze(
  [
    {
      location: 'assets/vfs/integrity.ts:62:10',
      propertyPath: 'bytes',
      kind: 'Uint8Array',
      rationale:
        'The public full-read contract transfers a detached byte copy to the caller; only metadata is immutable.'
    },
    ...(
      ['lightWords', 'directionalWords', 'headerWords', 'indexWords', 'overflowWords'] as const
    ).map((propertyPath) => ({
      location: 'rendering/lighting/culling/cluster-light-list.ts:416:10',
      propertyPath,
      kind: 'Uint32Array' as const,
      rationale:
        'PackedCpuClusterWords is a published immutable snapshot of typed word buffers crossing the CPU-to-GPU submission boundary; upload consumers read the frozen arrays.'
    })),
    {
      location: 'rendering/lighting/culling/cluster-light-list.ts:108:10',
      propertyPath: 'words',
      kind: 'Uint32Array',
      rationale:
        'PackedClusterGridWords transfers a freshly allocated, module-owned storage-buffer payload to the GPU cluster builder; consumers must treat the typed words as immutable.'
    },
    {
      location: 'rendering/lighting/culling/cluster-light-list.ts:132:10',
      propertyPath: 'words',
      kind: 'Uint32Array',
      rationale:
        'PackedWebGpuClusterLights transfers a freshly allocated, module-owned storage-buffer payload to the GPU cluster builder; consumers must treat the typed words as immutable.'
    },
    {
      location: 'rendering/lighting/culling/cluster-forward-abi.ts:55:10',
      propertyPath: 'words',
      kind: 'Uint32Array',
      rationale:
        'PackedClusterForwardMetadata transfers a freshly allocated, module-owned uniform payload to the forward cluster lookup; consumers must treat the typed words as immutable.'
    }
  ].sort((left, right) => left.location.localeCompare(right.location))
);

function nestedMutableExposures(sourceText: string): readonly NestedMutableExposure[] {
  return analyzeFreezeSource(sourceText).flatMap((call) => call.nestedMutableBuiltIns);
}

describe('Object.freeze governance', () => {
  test('allows only module-owned named empty snapshots', () => {
    expect(analyzeFreezeSource('const NO_VALUES = Object.freeze([]);')[0]?.category).toBeNull();
    expect(
      analyzeFreezeSource('function build() { const NO_VALUES = Object.freeze([]); }')[0]?.category
    ).toBe('inline-empty-array');
  });

  test('does not freeze inline empty arrays or direct mutable built-ins in production', () => {
    const audit = auditProductionFreeze();

    expect(audit.banned['inline-empty-array']).toEqual([]);
    expect(audit.banned['mutable-built-in']).toEqual([]);
    expect(audit.banned['typed-array']).toEqual([]);
  });

  test('follows identifier, member, array, spread, readonly-type, and runtime-private aliases', () => {
    expect(
      nestedMutableExposures(
        [
          'const mapAlias = new Map<string, number>();',
          'const outer = { nested: { mapAlias }, list: [new Set<string>()] };',
          'const alias = outer;',
          'const member = alias.nested.mapAlias;',
          'Object.freeze(alias);',
          'Object.freeze(member);',
          'Object.freeze({ ...outer });',
          'const readonlyTyped: ReadonlyMap<string, number> = new Map<string, number>();',
          'const holder = { readonlyTyped };',
          'Object.freeze(holder.readonlyTyped);',
          'Object.freeze(mapAlias);',
          'class Unsafe {',
          '  private table = new Map<string, number>();',
          '  constructor() { Object.freeze(this); }',
          '}'
        ].join('\n')
      )
    ).toEqual([
      { location: 'snippet.ts:5:1', propertyPath: 'nested.mapAlias', kind: 'Map' },
      { location: 'snippet.ts:5:1', propertyPath: 'list[0]', kind: 'Set' },
      { location: 'snippet.ts:6:1', propertyPath: '<root>', kind: 'Map' },
      { location: 'snippet.ts:7:1', propertyPath: 'nested.mapAlias', kind: 'Map' },
      { location: 'snippet.ts:7:1', propertyPath: 'list[0]', kind: 'Set' },
      { location: 'snippet.ts:10:1', propertyPath: '<root>', kind: 'Map' },
      { location: 'snippet.ts:11:1', propertyPath: '<root>', kind: 'Map' },
      { location: 'snippet.ts:14:19', propertyPath: 'table', kind: 'Map' }
    ]);
  });

  test('does not flag ECMAScript-private or WeakMap-backed enforcing facades', () => {
    expect(
      nestedMutableExposures(
        [
          'const privateBytes = new Uint8Array(4);',
          'const weakStorage = new WeakMap<object, Map<string, number>>();',
          'class PrivateFacade {',
          '  #table = new Map<string, number>();',
          '  constructor() { Object.freeze(this); }',
          '}',
          'class WeakMapFacade {',
          '  constructor() {',
          '    weakStorage.set(this, new Map<string, number>());',
          '    Object.freeze(this);',
          '  }',
          '}'
        ].join('\n')
      )
    ).toEqual([]);
  });

  test('follows array spreads but does not mistake an iterable source container for a publication', () => {
    expect(
      nestedMutableExposures(
        'const items = [new Map<string, number>()]; Object.freeze([...items]);'
      )
    ).toEqual([{ location: 'snippet.ts:1:44', propertyPath: '[0]', kind: 'Map' }]);
    expect(
      nestedMutableExposures(
        'const pending = new Set<Promise<unknown>>(); Object.freeze([...pending]);'
      )
    ).toEqual([]);
  });

  test('uses checker-backed symbol and initializer resolution for publication roots', () => {
    const exposures = nestedMutableExposures(
      [
        'const MapCtor = globalThis.Map;',
        'const table: ReadonlyMap<string, number> = new MapCtor<string, number>();',
        'const holder = { table };',
        "Object.freeze(holder['table']);",
        'function freezeParameter(value: Map<string, number>) { Object.freeze(value); }',
        'function factory() { return new Set<string>(); }',
        'Object.freeze(factory());',
        'Object.freeze([...new Set([new Uint16Array([1])])]);',
        'class ConstructorAssigned {',
        '  private table!: ReadonlyMap<string, number>;',
        '  constructor() { this.table = new Map<string, number>(); Object.freeze(this); }',
        '}'
      ].join('\n')
    );

    expect(exposures.map(({ propertyPath, kind }) => ({ propertyPath, kind }))).toEqual([
      { propertyPath: '<root>', kind: 'Map' },
      { propertyPath: '<root>', kind: 'Map' },
      { propertyPath: '<root>', kind: 'Set' },
      { propertyPath: '[0]', kind: 'Uint16Array' },
      { propertyPath: 'table', kind: 'Map' }
    ]);
  });

  test('follows conditional and computed paths and preserves object last-write semantics', () => {
    expect(
      nestedMutableExposures(
        [
          'const base = { table: new Map<string, number>() };',
          "const property = 'table' as const;",
          'Object.freeze({ ...base, table: undefined });',
          'Object.freeze({ ...base, [property]: new Set<string>() });',
          'Object.freeze(Math.random() > 0.5 ? base.table : new Uint8Array([1]));'
        ].join('\n')
      ).map(({ propertyPath, kind }) => ({ propertyPath, kind }))
    ).toEqual([
      { propertyPath: 'table', kind: 'Set' },
      { propertyPath: '<root>', kind: 'Map' },
      { propertyPath: '<root>', kind: 'Uint8Array' }
    ]);
  });

  test('resolves statically reachable built-in type graphs without trusting local names', () => {
    const exposures = nestedMutableExposures(
      [
        'const { table } = { table: new Map<string, number>() };',
        'Object.freeze(table);',
        'const readonlyFactory: () => ReadonlyMap<string, number> = () => new Map();',
        'Object.freeze(readonlyFactory());',
        'class MemberHolder { table = new Set<string>(); }',
        'Object.freeze(new MemberHolder());',
        'class AssignedHolder {',
        '  table!: ReadonlyMap<string, number>;',
        '  constructor() { this.table = new Map<string, number>(); }',
        '}',
        'Object.freeze(new AssignedHolder());',
        'class GetterHolder { get bytes(): Uint8Array { return new Uint8Array([1]); } }',
        'Object.freeze(new GetterHolder().bytes);',
        'interface ExtendedMap extends Map<string, number> {}',
        'function freezeExtended(value: ExtendedMap) { Object.freeze(value); }',
        'type AliasedSet = Set<string>;',
        'function freezeAliased(value: AliasedSet) { Object.freeze(value); }',
        'interface IndexedMap { [name: string]: Map<string, number>; }',
        'function freezeIndexed(value: IndexedMap) { Object.freeze(value); }',
        'function freezeConstrained<T extends Set<string>>(value: T) { Object.freeze(value); }'
      ].join('\n')
    );

    expect(exposures.map(({ propertyPath, kind }) => ({ propertyPath, kind }))).toEqual([
      { propertyPath: '<root>', kind: 'Map' },
      { propertyPath: '<root>', kind: 'Map' },
      { propertyPath: 'table', kind: 'Set' },
      { propertyPath: 'table', kind: 'Map' },
      { propertyPath: '<root>', kind: 'Uint8Array' },
      { propertyPath: '<root>', kind: 'Map' },
      { propertyPath: '<root>', kind: 'Set' },
      { propertyPath: '[index]', kind: 'Map' },
      { propertyPath: '<root>', kind: 'Set' }
    ]);
  });

  test('does not mistake local Map Set or typed-array spellings for standard mutable built-ins', () => {
    expect(
      nestedMutableExposures(
        [
          'class Map<K, V> {}',
          'class Set<T> {}',
          'class Uint8Array { constructor(_value: unknown) {} }',
          'Object.freeze(new Map<string, number>());',
          'Object.freeze(new Set<string>());',
          'Object.freeze(new Uint8Array([1]));',
          'Object.freeze(new globalThis.Map<string, number>());'
        ].join('\n')
      ).map(({ propertyPath, kind }) => ({ propertyPath, kind }))
    ).toEqual([{ propertyPath: '<root>', kind: 'Map' }]);
  });

  test('treats a public prototype getter as a mutable publication surface', () => {
    expect(
      nestedMutableExposures(
        [
          'class GetterFacade {',
          '  get table(): Map<string, number> { return new Map<string, number>(); }',
          '}',
          'Object.freeze(new GetterFacade());'
        ].join('\n')
      )
    ).toEqual([{ location: 'snippet.ts:4:1', propertyPath: 'table', kind: 'Map' }]);
  });

  test('follows standard array element types and public getter return surfaces', () => {
    const exposures = nestedMutableExposures(
      [
        'function freezeReadonlyMaps(values: readonly Map<string, number>[]) { Object.freeze(values); }',
        'function freezeReadonlySets(values: ReadonlyArray<Set<string>>) { Object.freeze(values); }',
        'Object.freeze({ get table(): Map<string, number> { return new Map<string, number>(); } });',
        'class ReturningGetter { get table(): Uint8Array { return new Uint8Array([1]); } }',
        'Object.freeze(new ReturningGetter());',
        'const aliases = new Set<string>();',
        'class AliasingGetter { get table(): ReadonlySet<string> { return aliases; } }',
        'Object.freeze(new AliasingGetter());'
      ].join('\n')
    );

    expect(exposures.map(({ propertyPath, kind }) => ({ propertyPath, kind }))).toEqual([
      { propertyPath: '[index]', kind: 'Map' },
      { propertyPath: '[index]', kind: 'Set' },
      { propertyPath: 'table', kind: 'Map' },
      { propertyPath: 'table', kind: 'Uint8Array' },
      { propertyPath: 'table', kind: 'Set' }
    ]);
  });

  test('follows named standard array aliases at unknown publication roots', () => {
    expect(
      nestedMutableExposures(
        [
          'type Tables = ReadonlyArray<Map<string, number>>;',
          'function freezeTables(tables: Tables) { Object.freeze(tables); }'
        ].join('\n')
      ).map(({ propertyPath, kind }) => ({ propertyPath, kind }))
    ).toEqual([{ propertyPath: '[index]', kind: 'Map' }]);
  });

  test('follows public getter returns through ECMAScript-private backing values', () => {
    expect(
      nestedMutableExposures(
        [
          'class PrivateMapGetter {',
          '  #table = new Map<string, number>();',
          '  get table(): ReadonlyMap<string, number> { return this.#table; }',
          '}',
          'Object.freeze(new PrivateMapGetter());',
          'class PrivateBytesGetter {',
          '  #bytes = new Uint8Array([1]);',
          '  get bytes(): Uint8Array { return this.#bytes; }',
          '}',
          'Object.freeze(new PrivateBytesGetter());',
          'class PrivateCopyGetter {',
          '  #bytes = new Uint8Array([1]);',
          '  get bytes(): Uint8Array { return this.#bytes.slice(); }',
          '}',
          'Object.freeze(new PrivateCopyGetter());'
        ].join('\n')
      ).map(({ propertyPath, kind }) => ({ propertyPath, kind }))
    ).toEqual([
      { propertyPath: 'table', kind: 'Map' },
      { propertyPath: 'bytes', kind: 'Uint8Array' }
    ]);
  });

  test('unions every syntactic object and class getter return path', () => {
    expect(
      nestedMutableExposures(
        [
          'Object.freeze({',
          '  get table(): Map<string, number> | undefined {',
          '    if (Math.random() > 0.5) return new Map<string, number>();',
          '    return undefined;',
          '  }',
          '});',
          'class MultipleReturns {',
          '  get bytes(): Uint8Array | undefined {',
          '    if (Math.random() > 0.5) return new Uint8Array([1]);',
          '    return undefined;',
          '  }',
          '}',
          'Object.freeze(new MultipleReturns());'
        ].join('\n')
      ).map(({ propertyPath, kind }) => ({ propertyPath, kind }))
    ).toEqual([
      { propertyPath: 'table', kind: 'Map' },
      { propertyPath: 'bytes', kind: 'Uint8Array' }
    ]);
  });

  test('threads public-surface provenance through getter aliases, branches, and arrays', () => {
    expect(
      nestedMutableExposures(
        [
          'class GetterPaths {',
          '  #table = new Map<string, number>();',
          '  #tables = [new Map<string, number>()];',
          '  #record = { table: new Map<string, number>() };',
          '  get alias(): ReadonlyMap<string, number> {',
          '    const local = this.#table;',
          '    return local;',
          '  }',
          '  get conditional(): ReadonlyMap<string, number> | undefined {',
          '    return Math.random() > 0.5 ? this.#table : undefined;',
          '  }',
          '  get call(): ReadonlyMap<string, number> { return (() => this.#table)(); }',
          '  get tables(): readonly ReadonlyMap<string, number>[] { return [this.#table]; }',
          '  get spread(): readonly ReadonlyMap<string, number>[] { return [...this.#tables]; }',
          '  get destructured(): ReadonlyMap<string, number> {',
          '    const [local] = this.#tables;',
          '    return local;',
          '  }',
          '  get member(): ReadonlyMap<string, number> { return { ...this.#record }.table; }',
          '  get directMember(): ReadonlyMap<string, number> { return this.#record.table; }',
          '}',
          'Object.freeze(new GetterPaths());',
          'class PublicField {',
          '  #table = new Map<string, number>();',
          '  table = this.#table;',
          '}',
          'Object.freeze(new PublicField());',
          'class PrivateOnly {',
          '  #table = new Map<string, number>();',
          '}',
          'Object.freeze(new PrivateOnly());'
        ].join('\n')
      ).map(({ propertyPath, kind }) => ({ propertyPath, kind }))
    ).toEqual([
      { propertyPath: 'alias', kind: 'Map' },
      { propertyPath: 'conditional', kind: 'Map' },
      { propertyPath: 'call', kind: 'Map' },
      { propertyPath: 'tables[0]', kind: 'Map' },
      { propertyPath: 'spread[0]', kind: 'Map' },
      { propertyPath: 'destructured', kind: 'Map' },
      { propertyPath: 'member', kind: 'Map' },
      { propertyPath: 'directMember', kind: 'Map' },
      { propertyPath: 'table', kind: 'Map' }
    ]);
  });

  test('retains conditional private constructor writes as possible getter values', () => {
    expect(
      nestedMutableExposures(
        [
          'class ConditionalClear {',
          '  #table: ReadonlyMap<string, number> | undefined = new Map<string, number>();',
          '  constructor(clear: boolean) { if (clear) this.#table = undefined; }',
          '  get table(): ReadonlyMap<string, number> | undefined { return this.#table; }',
          '}',
          'Object.freeze(new ConditionalClear(Math.random() > 0.5));'
        ].join('\n')
      ).map(({ propertyPath, kind }) => ({ propertyPath, kind }))
    ).toEqual([{ propertyPath: 'table', kind: 'Map' }]);
  });

  test('uses generic alias positions instead of treating every alias argument as mutable', () => {
    expect(
      nestedMutableExposures(
        [
          'type Tables<T> = ReadonlyArray<T>;',
          'function freezeTables(tables: Tables<Map<string, number>>) { Object.freeze(tables); }',
          'type Phantom<T> = { readonly id: string };',
          'function freezePhantom(value: Phantom<Map<string, number>>) { Object.freeze(value); }',
          'type Recursive<T> = { readonly child?: Recursive<T> };',
          'function freezeRecursive(value: Recursive<Map<string, number>>) { Object.freeze(value); }'
        ].join('\n')
      ).map(({ propertyPath, kind }) => ({ propertyPath, kind }))
    ).toEqual([{ propertyPath: '[index]', kind: 'Map' }]);
  });

  test('keeps public provenance through typed destructuring and literal-this aliases', () => {
    expect(
      nestedMutableExposures(
        [
          'class BindingAndSelf {',
          '  #items: unknown = [new Map<string, number>()];',
          '  #record: unknown = { table: new Set<string>() };',
          '  #bytes: unknown = new Uint8Array([1]);',
          '  get fromArray(): unknown {',
          '    const [item] = this.#items as readonly unknown[];',
          '    return item;',
          '  }',
          '  get fromObject(): unknown {',
          '    const { table } = this.#record as { readonly table: unknown };',
          '    return table;',
          '  }',
          '  get fromSelf(): unknown {',
          '    const self = this;',
          '    const alias = self;',
          '    return alias.#bytes;',
          '  }',
          '}',
          'Object.freeze(new BindingAndSelf());',
          'class PrivateAliasOnly {',
          '  #table: unknown = new Map<string, number>();',
          '  constructor() {',
          '    const self = this;',
          '    const alias = self;',
          '    Object.freeze(alias.#table);',
          '  }',
          '}'
        ].join('\n')
      ).map(({ propertyPath, kind }) => ({ propertyPath, kind }))
    ).toEqual([
      { propertyPath: 'fromArray', kind: 'Map' },
      { propertyPath: 'fromObject', kind: 'Set' },
      { propertyPath: 'fromSelf', kind: 'Uint8Array' }
    ]);
  });

  test('retains values when a successful constructor exit can precede an overwrite', () => {
    expect(
      nestedMutableExposures(
        [
          'class ReturnBeforeClear {',
          '  #table: unknown = new Map<string, number>();',
          '  constructor(keep: boolean) { if (keep) return; this.#table = undefined; }',
          '  get table(): unknown { return this.#table; }',
          '}',
          'Object.freeze(new ReturnBeforeClear(Math.random() > 0.5));',
          'class DirectClear {',
          '  #table: unknown = new Map<string, number>();',
          '  constructor() { this.#table = undefined; }',
          '  get table(): unknown { return this.#table; }',
          '}',
          'Object.freeze(new DirectClear());',
          'class ThrowBeforeClear {',
          '  #table: unknown = new Map<string, number>();',
          "  constructor(fail: boolean) { if (fail) throw new Error('fail'); this.#table = undefined; }",
          '  get table(): unknown { return this.#table; }',
          '}',
          'Object.freeze(new ThrowBeforeClear(false));'
        ].join('\n')
      ).map(({ propertyPath, kind }) => ({ propertyPath, kind }))
    ).toEqual([{ propertyPath: 'table', kind: 'Map' }]);
  });

  test('traverses direct named and generic readonly tuple elements at their indexes', () => {
    expect(
      nestedMutableExposures(
        [
          'function direct(value: readonly [Map<string, number>, number]) { Object.freeze(value); }',
          'type Named = readonly [Set<string>, number];',
          'function named(value: Named) { Object.freeze(value); }',
          'type Generic<T> = readonly [T, number];',
          'function generic(value: Generic<Uint8Array>) { Object.freeze(value); }',
          'type Recursive<T> = readonly [T, Recursive<T>?];',
          'function recursive(value: Recursive<Map<string, number>>) { Object.freeze(value); }',
          'function rest(value: readonly [number, ...Map<string, number>[]]) { Object.freeze(value); }',
          'function safe(value: readonly [number, string]) { Object.freeze(value); }'
        ].join('\n')
      ).map(({ propertyPath, kind }) => ({ propertyPath, kind }))
    ).toEqual([
      { propertyPath: '[0]', kind: 'Map' },
      { propertyPath: '[0]', kind: 'Set' },
      { propertyPath: '[0]', kind: 'Uint8Array' },
      { propertyPath: '[0]', kind: 'Map' },
      { propertyPath: '[index]', kind: 'Map' }
    ]);
  });

  test('models public binding defaults and object-rest materialization', () => {
    expect(
      nestedMutableExposures(
        [
          'class BindingDefaults {',
          '  #items: unknown = [Math.random() > 0.5 ? new Set<string>() : undefined];',
          '  #record: unknown = { table: Math.random() > 0.5 ? new Uint8Array([1]) : undefined };',
          '  #restRecord: unknown = { consumed: 1, table: new Map<string, number>() };',
          '  get arrayDefault(): unknown {',
          '    const [item = new Map<string, number>()] = this.#items as readonly unknown[];',
          '    return item;',
          '  }',
          '  get objectDefault(): unknown {',
          '    const { table = new Map<string, number>() } = this.#record as { readonly table?: unknown };',
          '    return table;',
          '  }',
          '  get rest(): unknown {',
          '    const { consumed, ...rest } = this.#restRecord as { readonly consumed: unknown; readonly table: unknown };',
          '    return rest;',
          '  }',
          '}',
          'Object.freeze(new BindingDefaults());'
        ].join('\n')
      ).map(({ propertyPath, kind }) => ({ propertyPath, kind }))
    ).toEqual([
      { propertyPath: 'arrayDefault', kind: 'Set' },
      { propertyPath: 'arrayDefault', kind: 'Map' },
      { propertyPath: 'objectDefault', kind: 'Uint8Array' },
      { propertyPath: 'objectDefault', kind: 'Map' },
      { propertyPath: 'rest.table', kind: 'Map' }
    ]);
  });

  test('materializes array holes as undefined without shifting destructured bindings', () => {
    expect(
      nestedMutableExposures(
        [
          'class HoleDefaults {',
          '  #items: unknown = [, new Set<string>()];',
          '  get defaultFromHole(): unknown {',
          '    const [value = new Map<string, number>()] = this.#items as readonly unknown[];',
          '    return value;',
          '  }',
          '  get laterBinding(): unknown {',
          '    const [, value] = this.#items as readonly unknown[];',
          '    return value;',
          '  }',
          '}',
          'Object.freeze(new HoleDefaults());',
          'class HoleWithoutDefault {',
          '  #items: unknown = [,];',
          '  get safe(): unknown {',
          '    const [value] = this.#items as readonly unknown[];',
          '    return value;',
          '  }',
          '}',
          'Object.freeze(new HoleWithoutDefault());'
        ].join('\n')
      ).map(({ propertyPath, kind }) => ({ propertyPath, kind }))
    ).toEqual([
      { propertyPath: 'defaultFromHole', kind: 'Map' },
      { propertyPath: 'laterBinding', kind: 'Set' }
    ]);
  });

  test('resolves public literal-this provenance through binding and member aliases only', () => {
    expect(
      nestedMutableExposures(
        [
          'class ThisAliasPaths {',
          '  #table: unknown = new Map<string, number>();',
          '  get bound(): unknown {',
          '    const { self } = { self: this };',
          '    return self.#table;',
          '  }',
          '  get chained(): unknown {',
          '    const holder = { self: this };',
          '    const next = { self: holder.self };',
          '    return next.self.#table;',
          '  }',
          '}',
          'Object.freeze(new ThisAliasPaths());',
          'class UnrelatedAlias {',
          '  #table: unknown = new Map<string, number>();',
          '  get safe(): unknown {',
          '    const holder = { self: {} };',
          '    return holder.self.#table;',
          '  }',
          '}',
          'Object.freeze(new UnrelatedAlias());'
        ].join('\n')
      ).map(({ propertyPath, kind }) => ({ propertyPath, kind }))
    ).toEqual([
      { propertyPath: 'bound', kind: 'Map' },
      { propertyPath: 'chained', kind: 'Map' }
    ]);
  });

  test('retains values when labeled constructor flow can bypass a later clear', () => {
    expect(
      nestedMutableExposures(
        [
          'class LabeledBypass {',
          '  #table: unknown = new Map<string, number>();',
          '  constructor(skip: boolean) { clear: { if (skip) break clear; this.#table = undefined; } }',
          '  get labeled(): unknown { return this.#table; }',
          '}',
          'Object.freeze(new LabeledBypass(true));',
          'class SwitchBypass {',
          '  #table: unknown = new Map<string, number>();',
          '  constructor(skip: boolean) { clear: { switch (skip) { case true: break clear; } this.#table = undefined; } }',
          '  get switched(): unknown { return this.#table; }',
          '}',
          'Object.freeze(new SwitchBypass(true));',
          'class TryBypass {',
          '  #table: unknown = new Map<string, number>();',
          '  constructor(skip: boolean) { clear: { try { if (skip) break clear; } finally {} this.#table = undefined; } }',
          '  get tried(): unknown { return this.#table; }',
          '}',
          'Object.freeze(new TryBypass(true));',
          'class LabeledClear {',
          '  #table: unknown = new Map<string, number>();',
          '  constructor() { clear: { this.#table = undefined; } }',
          '  get cleared(): unknown { return this.#table; }',
          '}',
          'Object.freeze(new LabeledClear());'
        ].join('\n')
      ).map(({ propertyPath, kind }) => ({ propertyPath, kind }))
    ).toEqual([
      { propertyPath: 'labeled', kind: 'Map' },
      { propertyPath: 'switched', kind: 'Map' },
      { propertyPath: 'tried', kind: 'Map' }
    ]);
  });

  test('does not widen concretely materialized values to their mutable annotations', () => {
    expect(
      nestedMutableExposures(
        [
          'const empty: ReadonlyArray<Map<string, number>> = [];',
          'Object.freeze(empty);',
          'function freezeNumbers(values: readonly number[]) { Object.freeze(values); }',
          'function freezeRecords(values: ReadonlyArray<Readonly<{ id: string }>>) { Object.freeze(values); }',
          'const absent: { readonly table?: ReadonlyMap<string, number> } = {};',
          'Object.freeze(absent);',
          'const cleared: { readonly table?: ReadonlyMap<string, number> | undefined } = { table: undefined };',
          'Object.freeze(cleared);',
          'class DeclaredOnly { declare table: ReadonlyMap<string, number>; }',
          'Object.freeze(new DeclaredOnly());',
          'class UndefinedField { table!: ReadonlyMap<string, number>; }',
          'Object.freeze(new UndefinedField());',
          'const ownedBytes = new Uint8Array([1]);',
          'class CopyingGetter { get bytes(): Uint8Array { return ownedBytes.slice(); } }',
          'Object.freeze(new CopyingGetter());'
        ].join('\n')
      )
    ).toEqual([]);
  });

  test('bounds cyclic alias resolution', () => {
    expect(
      nestedMutableExposures('const first = second; const second = first; Object.freeze(first);')
    ).toEqual([]);
  });

  test('requires reviewed allowlist entries for published nested mutable built-ins', () => {
    const productionExposures = auditProductionFreeze().nestedMutableBuiltIns.map(
      ({ path: _path, line: _line, column: _column, ...exposure }) => exposure
    );

    expect(productionExposures).toEqual(
      NESTED_MUTABLE_ALLOWLIST.map(({ rationale: _rationale, ...exposure }) => exposure)
    );
  });
});
