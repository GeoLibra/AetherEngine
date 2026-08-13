import { describe, expect, test } from 'vitest';
import {
  MaterialDiagnosticError,
  createMaterialAsset,
  createMaterialInstance,
  createMaterialTechniqueRole,
  defineMaterialSchema,
  rehydrateMaterialInstance,
  resolveMaterialAsset,
  snapshotMaterialInstance
} from '../../src';
import { PbrSchema, createPbrAsset, createPbrInstance, definePbrSchema } from './material-fixtures';

describe('immutable material assets and instances', () => {
  test('commits a multi-field/keyword transaction as exactly one revision', () => {
    const { instance } = createPbrInstance();
    const noOp = instance.edit(() => undefined);
    const next = instance.edit((draft) => {
      draft.set(PbrSchema.fields.roughness, 0.4);
      draft.setName('baseColor', [0.2, 0.3, 0.4, 1]);
      draft.setKeyword('SKINNED', true);
      draft.setKeyword('QUALITY', 'high');
      draft.setKeyword('SKINNED', false);
      draft.removeKeyword('MISSING');
    });

    expect(noOp).toBe(instance);
    expect(next).not.toBe(instance);
    expect(next.revision).toBe(instance.revision + 1);
    expect(next.parameters.get(PbrSchema.fields.roughness)).toBe(0.4);
    expect(next.parameters.get(PbrSchema.fields.baseColor)).toEqual([0.2, 0.3, 0.4, 1]);
    expect(next.keywords).toEqual({ QUALITY: 'high', SKINNED: false });
    expect(Object.keys(next.keywords)).toEqual(['QUALITY', 'SKINNED']);
    expect(Object.isFrozen(next.keywords)).toBe(true);

    expect(instance.revision).toBe(0);
    expect(instance.parameters.get(PbrSchema.fields.roughness)).toBe(1);
    expect(instance.parameters.get(PbrSchema.fields.baseColor)).toEqual([1, 1, 1, 1]);
    expect(instance.keywords).toEqual({});
  });

  test('validates every draft write before publishing any change', () => {
    const { instance } = createPbrInstance();

    expect(() =>
      instance.edit((draft) => {
        draft.set(PbrSchema.fields.roughness, 0.2);
        draft.setName('baseColor', [1, 2] as never);
      })
    ).toThrow(MaterialDiagnosticError);
    expect(instance.revision).toBe(0);
    expect(instance.parameters.get(PbrSchema.fields.roughness)).toBe(1);
  });

  test('rejects resolved reference mismatches and cross-logical-asset rebases', () => {
    const blue = createPbrAsset();
    expectDiagnostic(
      () => resolveMaterialAsset({ assetId: blue.id, payloadVersion: 99 }, blue),
      'incompatible-asset'
    );
    expectDiagnostic(
      () => resolveMaterialAsset({ assetId: 'material.other', payloadVersion: blue.version }, blue),
      'incompatible-asset'
    );

    const instance = createPbrInstance().instance;
    const other = createPbrAsset({ id: 'material.other', version: 2 });
    const result = instance.rebase(
      resolveMaterialAsset({ assetId: other.id, payloadVersion: other.version }, other)
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe('incompatible-asset');
  });

  test('rebases compatible owners by stable field id and preserves override provenance', () => {
    const initial = createPbrInstance();
    const inherited = initial.instance;
    const overridden = initial.instance.edit((draft) => {
      draft.set(PbrSchema.fields.roughness, 0.25);
    });
    const nextSchema = defineMaterialSchema({
      id: 'aether.material.pbr',
      version: 1,
      fields: {
        colorRenamed: {
          fieldId: 'base-color',
          name: 'color',
          aliases: ['baseColor'],
          valueType: { kind: 'vector', length: 4, format: 'f32' },
          defaultValue: [0.9, 0.9, 0.9, 1],
          bindingPath: 'baseColor'
        },
        roughnessRenamed: {
          fieldId: 'roughness',
          name: 'surfaceRoughness',
          aliases: ['roughness'],
          valueType: { kind: 'number', format: 'f32' },
          defaultValue: 0.8,
          bindingPath: 'roughness'
        }
      }
    });
    const nextAsset = createPbrAsset({ version: 2, schema: nextSchema });
    const resolved = resolveMaterialAsset(
      { assetId: nextAsset.id, payloadVersion: nextAsset.version },
      nextAsset
    );
    const inheritedResult = inherited.rebase(resolved);
    const overriddenResult = overridden.rebase(resolved);

    expect(inheritedResult.ok).toBe(true);
    expect(overriddenResult.ok).toBe(true);
    if (inheritedResult.ok && overriddenResult.ok) {
      expect(inheritedResult.instance.parameters.get(nextSchema.fields.roughnessRenamed)).toBe(0.8);
      expect(inheritedResult.instance.parameters.get(nextSchema.fields.colorRenamed)).toEqual([
        0.9, 0.9, 0.9, 1
      ]);
      expect(overriddenResult.instance.parameters.get(nextSchema.fields.roughnessRenamed)).toBe(
        0.25
      );
      expect(overriddenResult.instance.asset).toEqual({
        assetId: 'material.blue-paint',
        payloadVersion: 2
      });
    }
  });

  test('writing the current default clears override provenance', () => {
    const { instance } = createPbrInstance();
    const reset = instance.edit((draft) => {
      draft.set(PbrSchema.fields.roughness, 0.25);
      draft.set(PbrSchema.fields.roughness, 1);
    });
    const nextSchema = defineMaterialSchema({
      id: 'aether.material.pbr',
      version: 1,
      fields: {
        roughness: {
          fieldId: 'roughness',
          name: 'roughness',
          valueType: { kind: 'number', format: 'f32' },
          defaultValue: 0.6,
          bindingPath: 'roughness'
        },
        baseColor: {
          fieldId: 'base-color',
          name: 'baseColor',
          valueType: { kind: 'vector', length: 4, format: 'f32' },
          defaultValue: [1, 1, 1, 1],
          bindingPath: 'baseColor'
        }
      }
    });
    const asset = createPbrAsset({ version: 2, schema: nextSchema });
    const result = reset.rebase(
      resolveMaterialAsset({ assetId: asset.id, payloadVersion: asset.version }, asset)
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.instance.parameters.get(nextSchema.fields.roughness)).toBe(0.6);
    }
  });

  test.each([
    {
      label: 'value type',
      schema: () =>
        defineMaterialSchema({
          id: 'aether.material.pbr',
          version: 1,
          fields: {
            roughness: {
              fieldId: 'roughness',
              name: 'roughness',
              valueType: { kind: 'number', format: 'u32' },
              defaultValue: 1,
              bindingPath: 'roughness'
            }
          }
        })
    },
    {
      label: 'binding path',
      schema: () =>
        defineMaterialSchema({
          id: 'aether.material.pbr',
          version: 1,
          fields: {
            roughness: {
              fieldId: 'roughness',
              name: 'roughness',
              valueType: { kind: 'number', format: 'f32' },
              defaultValue: 1,
              bindingPath: 'different.roughness'
            }
          }
        })
    },
    {
      label: 'schema version',
      schema: () => {
        const schema = definePbrSchema();
        return defineMaterialSchema({
          id: String(schema.id),
          version: 2,
          fields: {
            roughness: {
              fieldId: 'roughness',
              name: 'roughness',
              valueType: { kind: 'number', format: 'f32' },
              defaultValue: 1,
              bindingPath: 'roughness'
            }
          }
        });
      }
    }
  ])('rejects rebase fingerprint drift in $label', ({ schema }) => {
    const instance = createPbrInstance().instance;
    const asset = createPbrAsset({ version: 2, schema: schema() as never });
    const result = instance.rebase(
      resolveMaterialAsset({ assetId: asset.id, payloadVersion: asset.version }, asset)
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe('incompatible-asset');
  });

  test('deep-snapshots and freezes caller-owned asset data', () => {
    const schemaDefault = [1, 1, 1, 1];
    const schema = defineMaterialSchema({
      id: 'test.material.immutable',
      version: 1,
      fields: {
        color: {
          fieldId: 'color',
          name: 'color',
          valueType: { kind: 'vector', length: 4, format: 'f32' },
          defaultValue: schemaDefault,
          bindingPath: 'color'
        }
      }
    });
    const features = ['feature-a'];
    const forward = createMaterialTechniqueRole('forward');
    const techniques = [
      {
        name: 'forward',
        passRole: forward,
        shader: { moduleKey: 'forward-shader', vertexEntry: 'vs', fragmentEntry: 'fs' },
        priority: 1,
        compatibility: {
          semanticTag: 'lit',
          bindingLayoutHash: 'layout',
          requiredFeatures: features,
          requiredMaterialFeatures: [],
          requiredViewFeatures: [],
          requiredMeshCapabilities: [],
          attachmentFormats: ['rgba16float'],
          depthStencilFormats: ['depth24plus'],
          sampleCounts: [1]
        }
      }
    ];
    const asset = createMaterialAsset({
      id: 'material.immutable',
      version: 7,
      schema,
      techniques,
      renderState: {
        surface: 'opaque',
        blend: { color: 'source-over', alpha: 'source-over' }
      }
    });
    const resolved = resolveMaterialAsset(
      { assetId: asset.id, payloadVersion: asset.version },
      asset
    );

    schemaDefault[0] = 9;
    features.push('feature-b');
    techniques[0]!.priority = 99;
    expect(asset.defaults.get(schema.fields.color)).toEqual([1, 1, 1, 1]);
    expect(asset.techniques).toEqual([
      {
        name: 'forward',
        passRole: forward,
        shader: { moduleKey: 'forward-shader', vertexEntry: 'vs', fragmentEntry: 'fs' },
        priority: 1,
        compatibility: {
          semanticTag: 'lit',
          bindingLayoutHash: 'layout',
          requiredFeatures: ['feature-a'],
          requiredMaterialFeatures: [],
          requiredViewFeatures: [],
          requiredMeshCapabilities: [],
          attachmentFormats: ['rgba16float'],
          depthStencilFormats: ['depth24plus'],
          sampleCounts: [1]
        }
      }
    ]);
    expect(() =>
      (
        asset.techniques[0]!.compatibility as unknown as { requiredFeatures: string[] }
      ).requiredFeatures.push('x')
    ).toThrow();
    expect(() => ((asset.renderState.blend as { color: string }).color = 'replace')).toThrow();
    expect(resolved.reference).toEqual({ assetId: 'material.immutable', payloadVersion: 7 });
    expect(Object.isFrozen(asset)).toBe(true);
    expect(Object.isFrozen(asset.techniques)).toBe(true);
    expect(Object.isFrozen(resolved.reference)).toBe(true);
  });
});

describe('material instance worker snapshots', () => {
  test('round-trips stable ids through structured clone and a new local schema owner', () => {
    const source = createPbrInstance().instance.edit((draft) => {
      draft.set(PbrSchema.fields.roughness, 0.3);
      draft.setKeyword('QUALITY', 'high');
    });
    const snapshot = snapshotMaterialInstance(source);
    const transported = structuredClone(snapshot);
    const localSchema = definePbrSchema();
    const localAsset = createPbrAsset({ schema: localSchema });
    const localResolved = resolveMaterialAsset(
      { assetId: localAsset.id, payloadVersion: localAsset.version },
      localAsset
    );
    const result = rehydrateMaterialInstance(transported, localResolved);

    expect(Object.getPrototypeOf(transported)).toBe(Object.prototype);
    expect(collectSymbols(transported)).toEqual([]);
    expect(JSON.stringify(transported)).not.toContain('index');
    expect(transported.parameters).toEqual({ 'base-color': [1, 1, 1, 1], roughness: 0.3 });
    expect(transported.overrides).toEqual({ roughness: 0.3 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.instance.revision).toBe(1);
      expect(result.instance.parameters.get(localSchema.fields.roughness)).toBe(0.3);
      expect(result.instance.keywords).toEqual({ QUALITY: 'high' });
    }
  });

  test('rejects snapshot fingerprint drift', () => {
    const source = createPbrInstance().instance;
    const snapshot = snapshotMaterialInstance(source);
    const driftedSchema = defineMaterialSchema({
      id: 'aether.material.pbr',
      version: 1,
      fields: {
        roughness: {
          fieldId: 'roughness',
          name: 'roughness',
          valueType: { kind: 'number', format: 'u32' },
          defaultValue: 1,
          bindingPath: 'roughness'
        }
      }
    });
    const asset = createPbrAsset({ schema: driftedSchema as never });
    const resolved = resolveMaterialAsset(
      { assetId: asset.id, payloadVersion: asset.version },
      asset
    );
    const result = rehydrateMaterialInstance(snapshot, resolved);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe('incompatible-asset');
  });

  test('returns a structured failure for malformed worker payloads', () => {
    const { resolved } = createPbrInstance();
    const result = rehydrateMaterialInstance({} as never, resolved);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe('incompatible-asset');
  });
});

function expectDiagnostic(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`Expected material diagnostic ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(MaterialDiagnosticError);
    expect((error as MaterialDiagnosticError).diagnostic.code).toBe(code);
  }
}

function collectSymbols(value: unknown, found: symbol[] = []): symbol[] {
  if (typeof value !== 'object' || value === null) return found;
  found.push(...Object.getOwnPropertySymbols(value));
  for (const entry of Object.values(value)) collectSymbols(entry, found);
  return found;
}
