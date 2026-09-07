import type { WebGL2BindingManifestEntry, WebGL2PhysicalBinding } from '../../../rhi/webgl2/types';
import type { CookedGlslEs300Module } from '../../types';

/**
 * Maps authored sampler bindings across all texture units referenced by cooked combined samplers.
 * A WebGL sampler object is bound to texture units, so one authored sampler occupies every unit
 * whose cooked combined sampler references that logical binding.
 */
export function mapStandardLitListPhysicalBindings(
  activeBindings: readonly WebGL2BindingManifestEntry[],
  emitted: CookedGlslEs300Module
): readonly WebGL2PhysicalBinding[] {
  return activeBindings.flatMap((binding) => {
    if (binding.kind !== 'sampler') {
      return [
        Object.freeze({
          ...binding,
          slot: binding.kind === 'uniform-buffer' ? binding.group : binding.binding
        })
      ];
    }
    return emitted.bindings.flatMap((programBinding) =>
      programBinding.kind === 'combined-sampler' &&
      programBinding.sampler?.group === binding.group &&
      programBinding.sampler.binding === binding.binding
        ? [Object.freeze({ ...binding, slot: programBinding.texture.binding })]
        : []
    );
  });
}
