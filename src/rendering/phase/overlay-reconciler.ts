import type {
  OverlayDiagnostic,
  OverlayPrimitive,
  OverlayReconciliation,
  OverlayScopePolicy
} from './types';

export type {
  OverlayDiagnostic,
  OverlayPrimitive,
  OverlayReconciliation,
  OverlayScopePolicy
} from './types';

/**
 * Reconciles the desired list of overlay primitives against the cached state.
 * Filters primitives based on scope-specific budgets (max primitive count and upload bytes)
 * and emits delta updates to minimize CPU-to-GPU memory transfer.
 */
export class OverlayReconciler {
  private readonly scopes = new Map<string, ReadonlyMap<string, OverlayPrimitive>>();

  /**
   * Reconciles a scope's desired primitive state against previous cache.
   * Enforces maxPrimitives and maxUploadBytes policies.
   */
  reconcile(
    scope: string,
    policy: OverlayScopePolicy,
    desired: readonly OverlayPrimitive[]
  ): OverlayReconciliation {
    if (!policy.owner) throw new Error('Overlay scope must declare an owner.');
    const unique = new Map<string, OverlayPrimitive>();
    for (const primitive of desired) {
      if (unique.has(primitive.key))
        throw new Error(`Duplicate overlay key "${primitive.key}" in scope "${scope}".`);
      unique.set(primitive.key, Object.freeze({ ...primitive }));
    }
    const ordered = [...unique.values()].sort((a, b) => a.key.localeCompare(b.key));
    let bytes = 0;
    const accepted: OverlayPrimitive[] = [];
    for (const primitive of ordered) {
      if (
        accepted.length >= policy.maxPrimitives ||
        bytes + primitive.uploadBytes > policy.maxUploadBytes
      )
        break;
      accepted.push(primitive);
      bytes += primitive.uploadBytes;
    }
    const overflowed = accepted.length !== ordered.length;
    const next = new Map(
      overflowed && policy.overflow === 'disable' ? [] : accepted.map((item) => [item.key, item])
    );
    const previous = this.scopes.get(scope) ?? new Map();
    const created = [...next.values()].filter((item) => !previous.has(item.key));
    const updated = [...next.values()].filter(
      (item) => previous.has(item.key) && previous.get(item.key)?.payload !== item.payload
    );
    const removed = [...previous.keys()].filter((key) => !next.has(key)).sort();
    this.scopes.set(scope, next);
    const diagnostic: OverlayDiagnostic | undefined = overflowed
      ? Object.freeze({
          scope,
          kind: policy.overflow === 'disable' ? ('disabled' as const) : ('truncated' as const),
          omitted: ordered.length - next.size
        })
      : undefined;
    return Object.freeze({
      created: Object.freeze(created),
      updated: Object.freeze(updated),
      removed: Object.freeze(removed),
      ...(diagnostic ? { diagnostic } : {})
    });
  }

  /**
   * Clears a scope and returns keys of all destroyed primitives for cleanup.
   */
  destroyScope(scope: string): readonly string[] {
    const removed = Object.freeze([...(this.scopes.get(scope)?.keys() ?? [])].sort());
    this.scopes.delete(scope);
    return removed;
  }
}
