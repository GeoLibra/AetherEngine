import type { RenderPhaseKind } from '../../rendering/phase';
import type { MaterialDiagnostic } from './diagnostic-types';
import type { MaterialRenderStateOverride } from './render-state-types';

declare const materialTechniqueRoleBrand: unique symbol;

/** Branded string token representing a rendering pass capability role. */
export type MaterialTechniqueRole = string & {
  readonly [materialTechniqueRoleBrand]: true;
};

/** Identifier referencing a shader module and specific entry points. */
export interface MaterialShaderEntryRef {
  readonly moduleKey: string;
  readonly vertexEntry: string;
  readonly fragmentEntry?: string;
}

/** Compatibility prerequisites that a draw context must fulfill to use a technique. */
export interface MaterialTechniqueCompatibility {
  readonly semanticTag: string;
  readonly bindingLayoutHash: string;
  readonly requiredFeatures: readonly string[];
  readonly requiredMaterialFeatures: readonly string[];
  readonly requiredViewFeatures: readonly string[];
  readonly requiredMeshCapabilities: readonly string[];
  readonly attachmentFormats: readonly string[];
  readonly depthStencilFormats: readonly string[];
  readonly sampleCounts: readonly number[];
}

/** Specific rendering implementation (shader + state override + compatibility rules). */
export interface MaterialTechnique {
  readonly name: string;
  readonly passRole: MaterialTechniqueRole;
  readonly shader: MaterialShaderEntryRef;
  readonly renderStateOverride?: MaterialRenderStateOverride;
  readonly priority: number;
  readonly fallbackFor?: readonly MaterialTechniqueRole[];
  readonly compatibility: Readonly<MaterialTechniqueCompatibility>;
}

/** Technique query criteria supplied by the render queue during draw preparation. */
export interface MaterialTechniqueRequest {
  readonly phase: RenderPhaseKind;
  readonly allowedRoles: readonly MaterialTechniqueRole[];
  readonly availableFeatures: readonly string[];
  readonly availableMaterialFeatures: readonly string[];
  readonly availableViewFeatures: readonly string[];
  readonly availableMeshCapabilities: readonly string[];
  readonly bindingLayoutHash: string;
  readonly attachmentFormats: readonly string[];
  readonly depthStencilFormat?: string;
  readonly sampleCount: number;
  readonly semanticTag: string;
}

/** Discriminated result of selecting an active technique for a render phase. */
export type MaterialTechniqueSelection =
  | Readonly<{
      status: 'selected' | 'fallback';
      technique: MaterialTechnique;
      requestedRole: MaterialTechniqueRole;
      selectedRole: MaterialTechniqueRole;
      fallbackReason?: string;
      candidatesExamined: number;
    }>
  | Readonly<{
      status: 'unsupported';
      requestedRole?: MaterialTechniqueRole;
      candidatesExamined: number;
      diagnostic: Readonly<MaterialDiagnostic & { readonly reasons: readonly string[] }>;
    }>;
