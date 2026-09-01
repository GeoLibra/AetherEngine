import { compareCodeUnits, stableHash } from '../../core';
import type {
  BindingGroupManifest,
  BufferFieldLayout,
  BufferLayoutManifest,
  CookedShaderRuntimeArtifact,
  ShaderBindingEntryManifest,
  ShaderBindingManifest,
  ShaderStage
} from '../types';
import { reflectBindingEntry } from './binding-reflection';
import {
  finalizeBufferLayoutManifest,
  measureType,
  resolveBufferLayoutOptions
} from './struct-layout';

/** Builds the canonical runtime binding manifest from validated native-cooker reflection. */
export function createCookedShaderBindingManifest(
  artifact: CookedShaderRuntimeArtifact,
  shaderAbiVersion: number
): ShaderBindingManifest {
  const bindingStages = new Map<string, Set<ShaderStage>>();
  for (const entryPoint of artifact.entryPoints) {
    for (const binding of entryPoint.bindings) {
      const key = `${binding.group}:${binding.binding}`;
      const stages = bindingStages.get(key) ?? new Set<ShaderStage>();
      stages.add(entryPoint.stage);
      bindingStages.set(key, stages);
    }
  }
  const grouped = new Map<number, ShaderBindingEntryManifest[]>();
  for (const binding of artifact.bindings) {
    const reflected = reflectBindingEntry(
      binding.group,
      binding.binding,
      binding.name,
      binding.typeName,
      binding.addressSpace as 'uniform' | 'storage' | 'handle',
      undefined
    );
    const stages = bindingStages.get(`${binding.group}:${binding.binding}`);
    if (!stages) {
      throw new Error(
        `Cooked binding ${binding.group}:${binding.binding} is not used by any entry point.`
      );
    }
    const entry = reflected;
    const entries = grouped.get(binding.group) ?? [];
    entries.push(entry);
    grouped.set(binding.group, entries);
  }
  const groups: BindingGroupManifest[] = [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([group, entries]) =>
      Object.freeze({
        group,
        visibility: Object.freeze(
          (['vertex', 'fragment', 'compute'] as const).filter((stage) =>
            artifact.bindings.some(
              (binding) =>
                binding.group === group &&
                bindingStages.get(`${binding.group}:${binding.binding}`)?.has(stage) === true
            )
          )
        ),
        entries: Object.freeze(entries.sort((left, right) => left.binding - right.binding))
      })
    );
  const bindingsBySlot = new Map(
    artifact.bindings.map((binding) => [`${binding.group}:${binding.binding}`, binding])
  );
  const buffers: BufferLayoutManifest[] = artifact.bufferLayouts.map((layout) => {
    const binding = bindingsBySlot.get(`${layout.group}:${layout.binding}`)!;
    const addressSpace = binding.addressSpace as 'uniform' | 'storage';
    const options = resolveBufferLayoutOptions({
      target: 'wgsl',
      addressSpace,
      access: binding.access === 'read-write' ? 'read_write' : 'read'
    });
    const fields: BufferFieldLayout[] = layout.fields.map((field) => {
      const measured = measureType(field.typeName, new Map(), options.policy, new Set());
      if (measured.shape.kind === 'struct') {
        throw new Error(`Cooked field "${layout.name}.${field.path}" must be a leaf type.`);
      }
      if (measured.size !== field.size || measured.alignment !== field.alignment) {
        throw new Error(
          `Cooked field "${layout.name}.${field.path}" layout disagrees with its reflected type.`
        );
      }
      return Object.freeze({
        path: field.path,
        offset: field.offset,
        size: field.size,
        alignment: field.alignment,
        ...(measured.stride === undefined ? {} : { stride: measured.stride }),
        scalarKind: measured.scalarKind,
        elementCount: measured.elementCount,
        shape: measured.shape
      });
    });
    return finalizeBufferLayoutManifest(
      layout.name,
      shaderAbiVersion,
      options,
      {
        size: layout.byteSize,
        alignment: layout.alignment,
        scalarKind: 'f32',
        elementCount: 1,
        shape: Object.freeze({ kind: 'struct' })
      },
      fields
    );
  });
  buffers.sort((left, right) => compareCodeUnits(left.name, right.name));
  const vertexInputs = Object.freeze(
    artifact.vertexInputs.map(({ location, name, typeName }) =>
      Object.freeze({ location, name, type: typeName })
    )
  );
  const fragmentOutputs = Object.freeze(
    artifact.fragmentOutputs.map(({ location, name, typeName }) =>
      Object.freeze({ location, name, type: typeName })
    )
  );
  const data = { shaderAbiVersion, target: 'wgsl', groups, buffers, vertexInputs, fragmentOutputs };
  return Object.freeze({
    shaderAbiVersion,
    groups: Object.freeze(groups),
    buffers: Object.freeze(buffers),
    vertexInputs,
    fragmentOutputs,
    layoutHash: stableHash(data)
  });
}
