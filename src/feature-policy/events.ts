import type { RHIDevice } from '../rhi/contracts/device';
import type { RHISurface } from '../rhi/contracts/surface';
import type { NativeLifecycleCoordinator } from '../native-runtime/lifecycle';
import type { BrowserGraphicsSession } from '../platform/types';

/** Owner events that can change a FeaturePolicy resolution. */
export type FeaturePolicySourceEvent =
  | Readonly<{ kind: 'graphics-changed'; device: RHIDevice; surface: RHISurface }>
  | Readonly<{ kind: 'profile-changed' }>
  | Readonly<{ kind: 'registry-changed' }>
  | Readonly<{ kind: 'budget-changed' }>;

/** Subscription boundary implemented by Host, Editor, native, or product owners. */
export interface FeaturePolicySourceEventPort {
  subscribe(listener: (event: FeaturePolicySourceEvent) => void): () => boolean;
}

/** Adapts browser resize and loss events without creating a Platform dependency on FeaturePolicy. */
export function createBrowserFeaturePolicySource(
  session: BrowserGraphicsSession
): FeaturePolicySourceEventPort {
  return {
    subscribe(listener) {
      return session.subscribe(() =>
        listener({ kind: 'graphics-changed', device: session.device, surface: session.surface })
      );
    }
  };
}

/** Adapts native surface and memory-pressure events at the lifecycle owner boundary. */
export function createNativeFeaturePolicySource(
  lifecycle: NativeLifecycleCoordinator,
  graphics: () => Readonly<{ device: RHIDevice; surface: RHISurface }> | undefined
): FeaturePolicySourceEventPort {
  return {
    subscribe(listener) {
      return lifecycle.subscribe((event) => {
        if (event.kind === 'memory-pressure') {
          listener({ kind: 'budget-changed' });
          return;
        }
        if (
          event.kind !== 'resize' &&
          event.kind !== 'surface-lost' &&
          event.kind !== 'surface-recreated'
        )
          return;
        const current = graphics();
        if (current !== undefined) {
          listener({ kind: 'graphics-changed', device: current.device, surface: current.surface });
        }
      });
    }
  };
}
