export type PbrParameterKey = 'metallic' | 'roughness' | 'normalScale' | 'occlusionStrength';

export interface PbrInspectorField {
  readonly id: string;
  readonly key: PbrParameterKey;
  readonly label: string;
  readonly minimum: number;
  readonly maximum: number;
  readonly step: number;
}

export interface PbrInspectorGroup {
  readonly id: string;
  readonly label: string;
  readonly fields: readonly PbrInspectorField[];
}

export interface PbrInspectorSchema {
  readonly groups: readonly PbrInspectorGroup[];
}

export type PbrInspectorSnapshot = Readonly<Record<PbrParameterKey, number>>;

/**
 * Authoring metadata for the MVP inspector. The UI derives its controls from
 * this declaration; the scene remains the authority for material updates.
 */
export const PBR_INSPECTOR_SCHEMA: PbrInspectorSchema = Object.freeze({
  groups: Object.freeze([
    Object.freeze({
      id: 'surface',
      label: 'Surface response',
      fields: Object.freeze([
        Object.freeze({
          id: 'metallic',
          key: 'metallic',
          label: 'Metallic',
          minimum: 0,
          maximum: 1,
          step: 0.01
        }),
        Object.freeze({
          id: 'roughness',
          key: 'roughness',
          label: 'Roughness',
          minimum: 0,
          maximum: 1,
          step: 0.01
        })
      ])
    }),
    Object.freeze({
      id: 'detail',
      label: 'Texture response',
      fields: Object.freeze([
        Object.freeze({
          id: 'normal-scale',
          key: 'normalScale',
          label: 'Normal scale',
          minimum: 0,
          maximum: 2,
          step: 0.01
        }),
        Object.freeze({
          id: 'occlusion-strength',
          key: 'occlusionStrength',
          label: 'Occlusion',
          minimum: 0,
          maximum: 1,
          step: 0.01
        })
      ])
    })
  ])
});

export function derivePbrInspectorGroups(schema: PbrInspectorSchema): readonly PbrInspectorGroup[] {
  return schema.groups;
}

export function createPbrInspectorSnapshot(): PbrInspectorSnapshot {
  return Object.freeze({
    metallic: 0,
    roughness: 0.5,
    normalScale: 1,
    occlusionStrength: 1
  });
}
