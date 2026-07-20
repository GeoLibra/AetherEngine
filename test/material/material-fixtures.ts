import {
  createMaterialAsset,
  createMaterialInstance,
  resolveMaterialAsset,
  defineMaterialSchema,
  type MaterialFieldDefinitions,
  type MaterialSchema,
  type MaterialTechnique
} from '../../src';

export function definePbrSchema() {
  return defineMaterialSchema({
    id: 'aether.material.pbr',
    version: 1,
    fields: {
      roughness: {
        fieldId: 'roughness',
        name: 'roughness',
        aliases: ['perceptualRoughness'],
        valueType: { kind: 'number', format: 'f32' },
        defaultValue: 1,
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
}

export const PbrSchema = definePbrSchema();

type PbrDefinitions = typeof PbrSchema extends MaterialSchema<infer D> ? D : never;

export function createPbrAsset<const D extends MaterialFieldDefinitions = PbrDefinitions>(
  options: {
    readonly id?: string;
    readonly version?: number;
    readonly schema?: MaterialSchema<D>;
    readonly techniques?: readonly MaterialTechnique[];
  } = {}
) {
  const id = options.id ?? 'material.blue-paint';
  const version = options.version ?? 1;
  return createMaterialAsset({
    id,
    version,
    schema: options.schema ?? (PbrSchema as unknown as MaterialSchema<D>),
    techniques: options.techniques ?? [],
    renderState: { blendMode: 'opaque', doubleSided: false }
  });
}

export function createPbrInstance<const D extends MaterialFieldDefinitions = PbrDefinitions>(
  options: Parameters<typeof createPbrAsset<D>>[0] = {}
) {
  const asset = createPbrAsset(options);
  const resolved = resolveMaterialAsset(
    { assetId: asset.id, payloadVersion: asset.version },
    asset
  );
  return { asset, resolved, instance: createMaterialInstance(resolved) };
}
