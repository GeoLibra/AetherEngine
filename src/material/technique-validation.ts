import { isRecord } from '../core';
import { MaterialDiagnosticError } from './diagnostics';
import type { MaterialSchema, MaterialTechnique } from './types';

export function validateMaterialTechniques(
  techniques: readonly MaterialTechnique[],
  schema: MaterialSchema,
  materialId: string
): void {
  for (const technique of techniques) {
    if (!isRecord(technique)) invalidTechnique(schema, materialId, 'Technique must be an object.');
    if (typeof technique.name !== 'string' || technique.name.trim() === '')
      invalidTechnique(schema, materialId, 'Technique name must not be empty.');
    if (typeof technique.passRole !== 'string' || technique.passRole.trim() === '')
      invalidTechnique(schema, materialId, 'Technique pass role must not be empty.');
    if (!Number.isFinite(technique.priority))
      invalidTechnique(schema, materialId, 'Technique priority must be finite.');
    validateTechniqueShader(technique.shader, schema, materialId);
    validateTechniqueCompatibility(technique.compatibility, schema, materialId);
    if (
      technique.fallbackFor !== undefined &&
      (!Array.isArray(technique.fallbackFor) ||
        !technique.fallbackFor.every((role) => typeof role === 'string' && role.trim() !== ''))
    ) {
      invalidTechnique(schema, materialId, 'Technique fallback roles must not be empty.');
    }
  }
}

function validateTechniqueShader(
  shader: unknown,
  schema: MaterialSchema,
  materialId: string
): void {
  if (
    !isRecord(shader) ||
    typeof shader.moduleKey !== 'string' ||
    shader.moduleKey.trim() === '' ||
    typeof shader.vertexEntry !== 'string' ||
    shader.vertexEntry.trim() === '' ||
    (shader.fragmentEntry !== undefined &&
      (typeof shader.fragmentEntry !== 'string' || shader.fragmentEntry.trim() === ''))
  ) {
    invalidTechnique(schema, materialId, 'Technique shader identity is invalid.');
  }
}

function validateTechniqueCompatibility(
  compatibility: unknown,
  schema: MaterialSchema,
  materialId: string
): void {
  if (!isRecord(compatibility))
    invalidTechnique(schema, materialId, 'Technique compatibility is missing.');
  const record = compatibility as Record<string, unknown>;
  for (const identity of ['semanticTag', 'bindingLayoutHash'] as const) {
    if (typeof record[identity] !== 'string' || record[identity].trim() === '')
      invalidTechnique(schema, materialId, `Technique ${identity} is invalid.`);
  }
  for (const field of [
    'requiredFeatures',
    'requiredMaterialFeatures',
    'requiredViewFeatures',
    'requiredMeshCapabilities',
    'attachmentFormats',
    'depthStencilFormats'
  ] as const) {
    const values = record[field];
    if (
      !Array.isArray(values) ||
      !values.every((value) => typeof value === 'string' && value.trim() !== '')
    ) {
      invalidTechnique(schema, materialId, `Technique ${field} must contain valid strings.`);
    }
  }
  const sampleCounts = record.sampleCounts;
  if (
    !Array.isArray(sampleCounts) ||
    !sampleCounts.every((value) => Number.isInteger(value) && value > 0)
  ) {
    invalidTechnique(schema, materialId, 'Technique sample counts must be positive integers.');
  }
}

function invalidTechnique(schema: MaterialSchema, materialId: string, message: string): never {
  throw new MaterialDiagnosticError({
    code: 'incompatible-asset',
    materialId,
    schemaId: schema.id,
    schemaVersion: schema.version,
    message: `Invalid material technique: ${message}`
  });
}
