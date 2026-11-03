import type { FeaturePolicySourceEvent, FeaturePolicySourceEventPort } from './events';

/** Composition-owned pressure events; profile selection stays outside the scheduler. */
export interface ResidencyPressureFeaturePolicySource extends FeaturePolicySourceEventPort {
  /** Requests a reduced profile on critical pressure and restores it after normal recovery. */
  update(pressure: 'normal' | 'constrained' | 'critical'): void;
}

/**
 * Bridges residency pressure to the FeaturePolicy profile-change event contract.
 * The callback synchronously selects an approved profile before listeners request restaging.
 * Returns false when no profile change is available. Repeated levels do not request restaging.
 * Constrained pressure preserves the previously selected profile until normal recovery.
 */
export function createResidencyPressureFeaturePolicySource(
  selectProfile: (downgrade: boolean) => boolean
): ResidencyPressureFeaturePolicySource {
  const listeners = new Set<(event: FeaturePolicySourceEvent) => void>();
  let downgraded = false;
  return Object.freeze({
    subscribe(listener: (event: FeaturePolicySourceEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(pressure: 'normal' | 'constrained' | 'critical') {
      if (pressure !== 'normal' && pressure !== 'constrained' && pressure !== 'critical')
        throw new Error('Residency pressure level is invalid.');
      if (pressure === 'constrained') return;
      const next = pressure === 'critical';
      if (next === downgraded || !selectProfile(next)) return;
      downgraded = next;
      for (const listener of [...listeners]) listener(Object.freeze({ kind: 'profile-changed' }));
    }
  });
}
