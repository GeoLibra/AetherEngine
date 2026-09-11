import type {
  WebGL2BindingManifestEntry,
  WebGL2PhysicalBinding,
  WebGL2ProgramBinding
} from '../../../rhi/webgl2/types';
import type { CookedGlslEs300Module } from '../../types';

type BindingKey = `${number}:${number}`;

function bindingKey(group: number, binding: number): BindingKey {
  return `${group}:${binding}`;
}

function allocateSlots(
  activeBindings: readonly WebGL2BindingManifestEntry[],
  kind: 'texture' | 'uniform-buffer'
): ReadonlyMap<BindingKey, number> {
  const result = new Map<BindingKey, number>();
  let slot = 0;
  const bindings = activeBindings
    .filter((binding) => binding.kind === kind)
    .sort((left, right) => left.group - right.group || left.binding - right.binding);
  for (const binding of bindings) {
    result.set(bindingKey(binding.group, binding.binding), slot++);
  }
  return result;
}

/**
 * Maps authored sampler bindings across all texture units referenced by cooked combined samplers.
 * A WebGL sampler object is bound to texture units, so one authored sampler occupies every unit
 * whose cooked combined sampler references that logical binding.
 */
export function mapStandardLitListPhysicalBindings(
  activeBindings: readonly WebGL2BindingManifestEntry[],
  emitted: CookedGlslEs300Module
): readonly WebGL2PhysicalBinding[] {
  const textureSlots = allocateSlots(activeBindings, 'texture');
  const uniformBufferSlots = allocateSlots(activeBindings, 'uniform-buffer');
  return activeBindings.flatMap((binding) => {
    if (binding.kind !== 'sampler') {
      return [
        Object.freeze({
          ...binding,
          slot:
            binding.kind === 'uniform-buffer'
              ? uniformBufferSlots.get(bindingKey(binding.group, binding.binding))!
              : textureSlots.get(bindingKey(binding.group, binding.binding))!
        })
      ];
    }
    return emitted.bindings.flatMap((programBinding) =>
      programBinding.kind === 'combined-sampler' &&
      programBinding.sampler?.group === binding.group &&
      programBinding.sampler.binding === binding.binding
        ? [
            Object.freeze({
              ...binding,
              slot: textureSlots.get(
                bindingKey(programBinding.texture.group, programBinding.texture.binding)
              )!
            })
          ]
        : []
    );
  });
}

/** Maps cooked GLSL uniform locations to the same collision-free physical slots. */
export function mapStandardLitListProgramBindings(
  emitted: CookedGlslEs300Module,
  _input: unknown
): readonly WebGL2ProgramBinding[] {
  const bindings: WebGL2BindingManifestEntry[] = [];
  for (const binding of emitted.bindings) {
    if (binding.kind === 'uniform-buffer') {
      bindings.push({
        group: binding.resource.group,
        binding: binding.resource.binding,
        name: binding.name,
        kind: 'uniform-buffer'
      });
    } else {
      bindings.push({
        group: binding.texture.group,
        binding: binding.texture.binding,
        name: binding.name,
        kind: 'texture'
      });
    }
  }
  const textureSlots = allocateSlots(bindings, 'texture');
  const uniformBufferSlots = allocateSlots(bindings, 'uniform-buffer');
  return emitted.bindings.map((binding) =>
    binding.kind === 'uniform-buffer'
      ? Object.freeze({
          kind: 'uniform-buffer' as const,
          name: binding.name,
          slot: uniformBufferSlots.get(
            bindingKey(binding.resource.group, binding.resource.binding)
          )!
        })
      : Object.freeze({
          kind: 'combined-sampler' as const,
          name: binding.name,
          slot: textureSlots.get(bindingKey(binding.texture.group, binding.texture.binding))!
        })
  );
}
