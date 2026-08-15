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
 * This list is intentionally empty: published nested mutable built-ins have enforcing facades or
 * detached accessors, while private typed arrays never appear as fields of a frozen publication.
 */
const NESTED_MUTABLE_ALLOWLIST: readonly ReviewedNestedMutableExposure[] = Object.freeze([]);

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
