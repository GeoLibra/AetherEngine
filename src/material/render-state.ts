import type { RenderPhaseKind } from '../rendering/render-phase';
import type {
  MaterialBlendIntent,
  MaterialCullMode,
  MaterialRenderStateIntent,
  MaterialRenderStateOverride,
  MaterialSurfaceKind,
  MaterialTechnique,
  MaterialTechniqueRole
} from './types';

export interface MaterialRenderPhaseContext {
  readonly phase: RenderPhaseKind;
  readonly defaults?: MaterialRenderStateOverride;
  readonly allowedOverrideRoles?: readonly MaterialTechniqueRole[];
}

export interface MaterialRenderStateConflict {
  readonly code: 'render-state-conflict';
  readonly message: string;
}

export type ResolvedMaterialRenderState =
  | Readonly<{
      status: 'resolved';
      phase: RenderPhaseKind;
      surface: MaterialSurfaceKind;
      depthTest: boolean;
      depthWrite: boolean;
      colorWrite: boolean;
      cullMode: MaterialCullMode;
      blend: MaterialBlendIntent | undefined;
    }>
  | Readonly<{
      status: 'conflict';
      diagnostic: Readonly<MaterialRenderStateConflict>;
    }>;

export function resolveMaterialRenderState(
  assetIntent: MaterialRenderStateIntent,
  phaseContext: MaterialRenderPhaseContext,
  techniqueOverride?: MaterialTechnique
): ResolvedMaterialRenderState {
  const surface = assetIntent.surface ?? 'opaque';
  if (surface === 'alpha-mask' && phaseContext.phase === 'transparent') {
    return conflict('Alpha-mask material intent cannot be resolved in the transparent phase.');
  }

  let state = {
    depthTest: assetIntent.depthTest ?? true,
    depthWrite: assetIntent.depthWrite ?? true,
    colorWrite: assetIntent.colorWrite ?? true,
    cullMode: assetIntent.cullMode ?? 'back',
    blend: assetIntent.blend
  };
  if (phaseContext.phase === 'transparent') {
    state = { ...state, depthTest: true, depthWrite: false };
  }
  state = mergeOverride(state, phaseContext.defaults);

  const override = techniqueOverride?.renderStateOverride;
  if (override !== undefined && Object.keys(override).length > 0) {
    const technique = techniqueOverride;
    if (technique === undefined) throw new Error('Technique override invariant failed.');
    if (!phaseContext.allowedOverrideRoles?.includes(technique.passRole)) {
      return conflict(
        `Technique role "${technique.passRole}" is not allowed to override this phase state.`
      );
    }
    state = mergeOverride(state, override);
  }

  return Object.freeze({
    status: 'resolved',
    phase: phaseContext.phase,
    surface,
    ...state,
    blend: state.blend === undefined ? undefined : Object.freeze({ ...state.blend })
  });
}

function mergeOverride(
  state: Readonly<{
    depthTest: boolean;
    depthWrite: boolean;
    colorWrite: boolean;
    cullMode: MaterialCullMode;
    blend: MaterialBlendIntent | undefined;
  }>,
  override: MaterialRenderStateOverride | undefined
) {
  if (override === undefined) return state;
  return {
    depthTest: override.depthTest ?? state.depthTest,
    depthWrite: override.depthWrite ?? state.depthWrite,
    colorWrite: override.colorWrite ?? state.colorWrite,
    cullMode: override.cullMode ?? state.cullMode,
    blend: override.blend ?? state.blend
  };
}

function conflict(message: string): ResolvedMaterialRenderState {
  return Object.freeze({
    status: 'conflict',
    diagnostic: Object.freeze({ code: 'render-state-conflict', message })
  });
}
