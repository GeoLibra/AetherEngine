import { compareCodeUnits } from '../core';
import type {
  MaterialAsset,
  MaterialTechnique,
  MaterialTechniqueRequest,
  MaterialTechniqueRole,
  MaterialTechniqueSelection
} from './types';

export function createMaterialTechniqueRole(name: string): MaterialTechniqueRole {
  if (name.trim() === '') throw new Error('Material technique role must not be empty.');
  return name as MaterialTechniqueRole;
}

export function selectMaterialTechnique(
  asset: MaterialAsset,
  request: MaterialTechniqueRequest
): MaterialTechniqueSelection {
  const requestedRole = request.allowedRoles[0];
  if (requestedRole === undefined) return unsupported(asset, undefined, 0, ['No role requested.']);

  let candidatesExamined = 0;
  const exact = candidatesForRole(asset.techniques, requestedRole);
  for (const technique of exact) {
    candidatesExamined += 1;
    if (isCompatible(technique, request)) {
      return Object.freeze({
        status: 'selected',
        technique,
        requestedRole,
        selectedRole: technique.passRole,
        candidatesExamined
      });
    }
  }

  for (const role of request.allowedRoles.slice(1)) {
    const fallbacks = candidatesForRole(asset.techniques, role).filter((technique) =>
      technique.fallbackFor?.includes(requestedRole)
    );
    for (const technique of fallbacks) {
      candidatesExamined += 1;
      if (isCompatible(technique, request)) {
        return Object.freeze({
          status: 'fallback',
          technique,
          requestedRole,
          selectedRole: technique.passRole,
          fallbackReason: `No compatible exact ${requestedRole} technique; using declared ${role} fallback.`,
          candidatesExamined
        });
      }
    }
  }

  return unsupported(asset, requestedRole, candidatesExamined, [
    `No compatible exact ${requestedRole} technique.`,
    'No explicitly declared compatible fallback was available.'
  ]);
}

function candidatesForRole(
  techniques: readonly MaterialTechnique[],
  role: MaterialTechniqueRole
): MaterialTechnique[] {
  return techniques
    .filter((technique) => technique.passRole === role)
    .sort(
      (left, right) => right.priority - left.priority || compareCodeUnits(left.name, right.name)
    );
}

function isCompatible(technique: MaterialTechnique, request: MaterialTechniqueRequest): boolean {
  const compatibility = technique.compatibility;
  return (
    compatibility.semanticTag === request.semanticTag &&
    compatibility.bindingLayoutHash === request.bindingLayoutHash &&
    isSubset(compatibility.requiredFeatures, request.availableFeatures) &&
    isSubset(compatibility.requiredMaterialFeatures, request.availableMaterialFeatures) &&
    isSubset(compatibility.requiredViewFeatures, request.availableViewFeatures) &&
    isSubset(compatibility.requiredMeshCapabilities, request.availableMeshCapabilities) &&
    arraysEqual(compatibility.attachmentFormats, request.attachmentFormats) &&
    (request.depthStencilFormat === undefined
      ? compatibility.depthStencilFormats.length === 0
      : compatibility.depthStencilFormats.includes(request.depthStencilFormat)) &&
    compatibility.sampleCounts.includes(request.sampleCount)
  );
}

function isSubset(required: readonly string[], available: readonly string[]): boolean {
  const availableSet = new Set(available);
  return required.every((feature) => availableSet.has(feature));
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function unsupported(
  asset: MaterialAsset,
  requestedRole: MaterialTechniqueRole | undefined,
  candidatesExamined: number,
  reasons: readonly string[]
): MaterialTechniqueSelection {
  const diagnostic = Object.freeze({
    code: 'no-compatible-technique' as const,
    materialId: asset.id,
    schemaId: asset.schema.id,
    schemaVersion: asset.schema.version,
    message: reasons.join(' '),
    reasons: Object.freeze([...reasons])
  });
  const common = { status: 'unsupported' as const, candidatesExamined, diagnostic };
  return Object.freeze(
    requestedRole === undefined ? common : { ...common, requestedRole }
  ) as MaterialTechniqueSelection;
}
