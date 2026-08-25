/**
 * Represents a single visual primitive (e.g. line, box, text) in the editor overlay.
 */
export interface OverlayPrimitive {
  readonly key: string;
  readonly uploadBytes: number;
  readonly payload: unknown;
}

/**
 * Defines execution policy and budgets for an overlay scope.
 */
export interface OverlayScopePolicy {
  readonly owner: string;
  readonly maxPrimitives: number;
  readonly maxUploadBytes: number;
  readonly overflow: 'truncate' | 'disable'; // How to handle budget overflow
}

export interface OverlayDiagnostic {
  readonly scope: string;
  readonly kind: 'truncated' | 'disabled';
  readonly omitted: number;
}

/**
 * The set of mutations to sync the low-level rendering buffer with the desired state.
 */
export interface OverlayReconciliation {
  readonly created: readonly OverlayPrimitive[];
  readonly updated: readonly OverlayPrimitive[];
  readonly removed: readonly string[];
  readonly diagnostic?: OverlayDiagnostic;
}
