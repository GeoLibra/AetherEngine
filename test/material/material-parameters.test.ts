import { describe, expect, test } from 'vitest';
import {
  MaterialDiagnosticError,
  type MaterialField,
  type MaterialValue,
  createMaterialAsset,
  createMaterialInstance,
  createMaterialParameterBlock,
  defineMaterialSchema,
  getMaterialMetrics,
  rehydrateMaterialInstance,
  resetMaterialMetrics,
  resolveMaterialAsset,
  snapshotMaterialInstance
} from '../../src';
import { setMaterialParameterAtIndex } from '../../src/material/internal';
import { PbrSchema, createPbrAsset, createPbrInstance, definePbrSchema } from './material-fixtures';

describe('material schema view', () => {
  test('resolves active names and aliases to generated typed field tokens', () => {
    expect(PbrSchema.field('roughness')).toBe(PbrSchema.fields.roughness);
    expect(PbrSchema.field('perceptualRoughness')).toBe(PbrSchema.fields.roughness);
    expect(PbrSchema.tryField('missing')).toBeNull();
    expect(PbrSchema.fields.roughness).toMatchObject({
      fieldId: 'roughness',
      index: 0,
      name: 'roughness',
      schemaId: 'aether.material.pbr',
      schemaVersion: 1,
      valueType: { kind: 'number', format: 'f32' },
      bindingPath: 'roughness'
    });
    expect(PbrSchema.fields.baseColor.index).toBe(1);

    const typedNumber: MaterialField<number> = PbrSchema.fields.roughness;
    const nameResult: MaterialField<MaterialValue> = PbrSchema.field('roughness');
    expect(typedNumber).toBe(PbrSchema.fields.roughness);
    expect(nameResult).toBe(PbrSchema.fields.roughness);

    // @ts-expect-error Name lookup deliberately cannot fabricate a concrete generic.
    const fabricated: MaterialField<number> = PbrSchema.field('roughness');
    expect(fabricated).toBe(PbrSchema.fields.roughness);
  });

  test('keeps aliases out of the shared persistence schema', () => {
    expect(PbrSchema.typeSchema.fields).toEqual([
      expect.objectContaining({ id: 'roughness', name: 'roughness' }),
      expect.objectContaining({ id: 'base-color', name: 'baseColor' })
    ]);
    expect(PbrSchema.typeSchema.fields.some((field) => field.name === 'perceptualRoughness')).toBe(
      false
    );
  });

  test.each([
    {
      label: 'duplicate active names',
      code: 'duplicate-field',
      fields: {
        first: numericField('first', 'same'),
        second: numericField('second', 'same')
      }
    },
    {
      label: 'duplicate field ids',
      code: 'duplicate-field',
      fields: {
        first: numericField('same-id', 'first'),
        second: numericField('same-id', 'second')
      }
    },
    {
      label: 'an alias colliding with an active name',
      code: 'invalid-alias',
      fields: {
        first: { ...numericField('first', 'first'), aliases: ['second'] },
        second: numericField('second', 'second')
      }
    },
    {
      label: 'aliases colliding with each other',
      code: 'invalid-alias',
      fields: {
        first: { ...numericField('first', 'first'), aliases: ['oldName'] },
        second: { ...numericField('second', 'second'), aliases: ['oldName'] }
      }
    }
  ])('rejects $label', ({ fields, code }) => {
    expect(() =>
      defineMaterialSchema({ id: 'test.material.invalid', version: 1, fields })
    ).toThrowError(expectMaterialDiagnostic(code));
  });

  test('rejects defaults that do not match the declared material value type', () => {
    expect(() =>
      defineMaterialSchema({
        id: 'test.material.invalid-default',
        version: 1,
        fields: {
          roughness: {
            ...numericField('roughness', 'roughness'),
            defaultValue: 'not-a-number' as never
          }
        }
      })
    ).toThrowError(expectMaterialDiagnostic('type-mismatch'));
  });
});

describe('immutable material parameter blocks', () => {
  test('typed, name/alias, and internal index writes converge on identical values', () => {
    const defaults = createMaterialParameterBlock(PbrSchema);
    const typed = defaults.with(PbrSchema.fields.roughness, 0.35);
    const named = defaults.withName('perceptualRoughness', 0.35);
    const indexed = setMaterialParameterAtIndex(defaults, PbrSchema.fields.roughness.index, 0.35);

    for (const block of [typed, named, indexed]) {
      expect(block.get(PbrSchema.fields.roughness)).toBe(0.35);
      expect(block.getByName('roughness')).toBe(0.35);
      expect(block.getByName('perceptualRoughness')).toBe(0.35);
    }
    expect(typed).toEqual(named);
    expect(named).toEqual(indexed);

    if (false) {
      // @ts-expect-error A numeric token only accepts a numeric material value.
      defaults.with(PbrSchema.fields.roughness, [1, 2, 3, 4]);
    }
  });

  test('rejects foreign owner, stale version, and definition-drift tokens before indexing', () => {
    const block = createMaterialParameterBlock(PbrSchema);
    const equivalentOwner = definePbrSchema();
    const staleVersion = defineMaterialSchema({
      id: 'aether.material.pbr',
      version: 2,
      fields: {
        roughness: numericField('roughness', 'roughness')
      }
    });
    const drifted = defineMaterialSchema({
      id: 'aether.material.pbr',
      version: 1,
      fields: {
        roughness: {
          ...numericField('roughness', 'roughness'),
          bindingPath: 'different.path'
        }
      }
    });
    const reordered = defineMaterialSchema({
      id: 'aether.material.pbr',
      version: 1,
      fields: {
        baseColor: {
          fieldId: 'base-color',
          name: 'baseColor',
          valueType: { kind: 'vector' as const, length: 4 as const, format: 'f32' as const },
          defaultValue: [1, 1, 1, 1],
          bindingPath: 'baseColor'
        },
        roughness: numericField('roughness', 'roughness')
      }
    });

    expectDiagnostic(() => block.with(equivalentOwner.fields.roughness, 0.5), 'schema-mismatch');
    expectDiagnostic(() => block.with(staleVersion.fields.roughness, 0.5), 'stale-field');
    expectDiagnostic(() => block.with(drifted.fields.roughness, 0.5), 'stale-field');
    expectDiagnostic(() => block.with(reordered.fields.roughness, 0.5), 'schema-mismatch');
    expect(block.get(PbrSchema.fields.roughness)).toBe(1);
  });

  test('reports wrong values and unknown names without publishing a partial block', () => {
    const block = createMaterialParameterBlock(PbrSchema);

    expectDiagnostic(
      () => block.with(PbrSchema.fields.baseColor, [1, 2] as never),
      'type-mismatch'
    );
    expectDiagnostic(() => block.withName('missing', 1), 'unknown-field');
    expectDiagnostic(() => block.getByName('missing'), 'unknown-field');
    expect(block.get(PbrSchema.fields.baseColor)).toEqual([1, 1, 1, 1]);
  });

  test('deep-snapshots input values and reuses immutable reads', () => {
    const input = [0.1, 0.2, 0.3, 1];
    const block = createMaterialParameterBlock(PbrSchema).with(PbrSchema.fields.baseColor, input);
    input[0] = 9;

    const first = block.get(PbrSchema.fields.baseColor);
    const second = block.get(PbrSchema.fields.baseColor);
    expect(first).toBe(second);
    expect(first).toEqual([0.1, 0.2, 0.3, 1]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => ((first as number[])[0] = 8)).toThrow();
  });

  test('returns the same block for semantic no-op writes', () => {
    const block = createMaterialParameterBlock(PbrSchema);
    expect(block.with(PbrSchema.fields.roughness, 1)).toBe(block);
    expect(block.withName('perceptualRoughness', 1)).toBe(block);
  });

  test('counts exactly one block clone and one value snapshot per committed write', () => {
    resetMaterialMetrics();
    const defaults = createMaterialParameterBlock(PbrSchema);
    const edited = defaults.with(PbrSchema.fields.roughness, 0.5);
    const noOp = edited.with(PbrSchema.fields.roughness, 0.5);

    expect(noOp).toBe(edited);
    expect(getMaterialMetrics()).toEqual({ blocksCloned: 1, valuesSnapshotted: 1 });
    expect(Object.isFrozen(getMaterialMetrics())).toBe(true);
  });
});

describe('material Task 1 review regressions', () => {
  test('preserves an explicit override through an equal intermediate asset default', () => {
    const v1 = createVersionedRoughnessAsset(1, 1);
    const initial = createMaterialInstance(
      resolveMaterialAsset({ assetId: v1.id, payloadVersion: v1.version }, v1)
    );
    const overridden = initial.edit((draft) => draft.set(v1.schema.fields.roughness, 0.5));
    const v2 = createVersionedRoughnessAsset(2, 0.5);
    const atV2 = overridden.rebase(
      resolveMaterialAsset({ assetId: v2.id, payloadVersion: v2.version }, v2)
    );
    expect(atV2.ok).toBe(true);

    const v3 = createVersionedRoughnessAsset(3, 0.8);
    if (atV2.ok) {
      expect(snapshotMaterialInstance(atV2.instance).overrides).toEqual({ roughness: 0.5 });
      const atV3 = atV2.instance.rebase(
        resolveMaterialAsset({ assetId: v3.id, payloadVersion: v3.version }, v3)
      );
      expect(atV3.ok).toBe(true);
      if (atV3.ok) expect(atV3.instance.parameters.get(v3.schema.fields.roughness)).toBe(0.5);

      const cleared = atV2.instance.edit((draft) => draft.set(v2.schema.fields.roughness, 0.5));
      expect(cleared).not.toBe(atV2.instance);
      expect(snapshotMaterialInstance(cleared).overrides).toEqual({});
      const clearedAtV3 = cleared.rebase(
        resolveMaterialAsset({ assetId: v3.id, payloadVersion: v3.version }, v3)
      );
      expect(clearedAtV3.ok).toBe(true);
      if (clearedAtV3.ok) {
        expect(clearedAtV3.instance.parameters.get(v3.schema.fields.roughness)).toBe(0.8);
      }
    }
  });

  test('rejects snapshots whose non-default parameter is missing override provenance', () => {
    const { instance, resolved } = createPbrInstance();
    const missing = structuredClone(snapshotMaterialInstance(instance));
    (missing.parameters as Record<string, MaterialValue>).roughness = 0.25;

    const missingResult = rehydrateMaterialInstance(missing, resolved);
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(missingResult.diagnostic.code).toBe('incompatible-asset');
  });

  test('rejects structurally fabricated assets and resolutions', () => {
    const asset = createPbrAsset();
    const fabricatedAsset = {
      ...asset,
      techniques: [],
      renderState: { surface: 'transparent' }
    } as typeof asset;
    const reference = { assetId: asset.id, payloadVersion: asset.version };
    const fabricatedResolution = { reference, asset };

    expectDiagnostic(() => resolveMaterialAsset(reference, fabricatedAsset), 'incompatible-asset');
    expectDiagnostic(() => createMaterialInstance(fabricatedResolution), 'incompatible-asset');
    const rebase = createPbrInstance().instance.rebase(fabricatedResolution);
    expect(rebase.ok).toBe(false);
    expect(Object.isFrozen(asset)).toBe(true);
    expect(Object.isFrozen(resolveMaterialAsset(reference, asset))).toBe(true);
  });

  test('uses locale-independent code-unit ordering for every canonical material record', () => {
    const schema = defineMaterialSchema({
      id: 'test.material.canonical-order',
      version: 1,
      fields: {
        lower: numericField('a-field', 'lower'),
        upper: numericField('Z-field', 'upper')
      }
    });
    const asset = createMaterialAsset({
      id: 'material.canonical-order',
      version: 1,
      schema,
      techniques: [],
      renderState: {}
    });
    const instance = createMaterialInstance(
      resolveMaterialAsset({ assetId: asset.id, payloadVersion: asset.version }, asset)
    ).edit((draft) => {
      draft.set(schema.fields.lower, 2);
      draft.set(schema.fields.upper, 3);
      draft.setKeyword('a-keyword', true);
      draft.setKeyword('Z-keyword', true);
    });
    const snapshot = snapshotMaterialInstance(instance);

    expect(schema.fingerprint.indexOf('Z-field')).toBeLessThan(
      schema.fingerprint.indexOf('a-field')
    );
    expect(Object.keys(instance.keywords)).toEqual(['Z-keyword', 'a-keyword']);
    expect(Object.keys(snapshot.parameters)).toEqual(['Z-field', 'a-field']);
    expect(Object.keys(snapshot.overrides)).toEqual(['Z-field', 'a-field']);
  });
});

function numericField(fieldId: string, name: string) {
  return {
    fieldId,
    name,
    valueType: { kind: 'number' as const, format: 'f32' as const },
    defaultValue: 1,
    bindingPath: name
  };
}

function createVersionedRoughnessAsset(version: number, defaultValue: number) {
  const schema = defineMaterialSchema({
    id: 'test.material.versioned-roughness',
    version: 1,
    fields: {
      roughness: {
        ...numericField('roughness', 'roughness'),
        defaultValue
      }
    }
  });
  return createMaterialAsset({
    id: 'material.versioned-roughness',
    version,
    schema,
    techniques: [],
    renderState: {}
  });
}

function expectMaterialDiagnostic(code: string): new (...args: never[]) => MaterialDiagnosticError {
  class ExpectedMaterialDiagnostic extends MaterialDiagnosticError {
    constructor() {
      super({
        code: code as never,
        schemaId: 'test.material.invalid',
        schemaVersion: 1,
        message: code
      });
    }
  }
  Object.defineProperty(ExpectedMaterialDiagnostic, Symbol.hasInstance, {
    value(value: unknown) {
      return value instanceof MaterialDiagnosticError && value.diagnostic.code === code;
    }
  });
  return ExpectedMaterialDiagnostic;
}

function expectDiagnostic(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`Expected material diagnostic ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(MaterialDiagnosticError);
    expect((error as MaterialDiagnosticError).diagnostic.code).toBe(code);
  }
}
