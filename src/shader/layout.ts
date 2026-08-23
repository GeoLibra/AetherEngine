import { stableHash } from './hash';
import {
  bindingKey,
  indexBindingRequirements,
  reflectBindingEntry,
  reflectionError
} from './binding-reflection';
export { ShaderBindingReflectionError } from './binding-reflection';
import {
  selectShaderLayoutPolicy,
  shaderLayoutPolicy,
  type ShaderLayoutPolicy,
  type ShaderLayoutPolicyId
} from './layout-policy';
import type {
  BindingGroupManifest,
  BufferFieldLayout,
  BufferFieldLayoutShape,
  BufferLayoutManifest,
  ShaderBindingEntryManifest,
  ShaderBindingManifest,
  ShaderBindingManifestOptions,
  ShaderStage,
  ShaderGlobalIR,
  ShaderModuleIR,
  ShaderScalarKind,
  ShaderSamplerBindingRequirement,
  ShaderStructTypeIR,
  ShaderTarget
} from './types';

/**
 * Dimensions and alignment layout computed for a single struct member or variable type.
 */
interface TypeLayout {
  readonly size: number; // Total size in bytes (including tail padding if necessary)
  readonly alignment: number; // Necessary alignment boundaries in bytes (e.g. 4, 8, 16)
  readonly scalarKind: ShaderScalarKind; // Primitive type representation
  readonly elementCount: number; // Array/vector elements count
  readonly stride?: number; // Offset stride between consecutive array/matrix members
  readonly shape: BufferFieldLayoutShape | Readonly<{ kind: 'struct' }>;
}

export interface BufferLayoutOptions {
  readonly policy?: ShaderLayoutPolicyId;
  readonly target?: ShaderTarget;
  readonly addressSpace?: 'uniform' | 'storage';
  readonly access?: 'read' | 'read_write';
}

interface ResolvedBufferLayoutOptions {
  readonly policy: ShaderLayoutPolicy;
  readonly target: ShaderTarget;
  readonly addressSpace: 'uniform' | 'storage';
  readonly access: 'read' | 'read_write';
}

const ROOT_BUFFER_FIELD_PATH = '$root';

/**
 * Recursively maps and aligns struct field declarations into a BufferLayoutManifest.
 *
 * Sizing/Alignment Logic:
 * - Uses the specified layout policy (std140, wgsl-uniform, wgsl-storage) to compute sizes.
 * - Struct members are aligned according to the policy's alignment rules.
 * - Prevents infinite recursion through checking structure dependencies (`active` set cycle check).
 */
export function createBufferLayoutManifest(
  name: string,
  root: ShaderStructTypeIR,
  types: readonly ShaderStructTypeIR[],
  shaderAbiVersion: number,
  options: BufferLayoutOptions = {}
): BufferLayoutManifest {
  const resolved = resolveBufferLayoutOptions(options);
  const { policy } = resolved;
  const structs = new Map(types.map((type) => [type.name, type]));
  const fields: BufferFieldLayout[] = [];
  const layoutStruct = (
    struct: ShaderStructTypeIR,
    baseOffset: number,
    prefix: string,
    active: ReadonlySet<string>
  ): TypeLayout => {
    if (active.has(struct.name)) throw recursiveStructError(active, struct.name);
    const nextActive = new Set(active).add(struct.name);
    let cursor = 0;
    let memberAlignment = 1;
    for (const field of struct.fields) {
      const nested = structs.get(field.type);
      const layout = nested
        ? measureStruct(nested, structs, policy, nextActive)
        : measureType(field.type, structs, policy, nextActive);
      cursor = align(cursor, layout.alignment);
      const path = prefix ? `${prefix}.${field.name}` : field.name;
      const array = arrayElement(field.type);
      if (nested) {
        layoutStruct(nested, baseOffset + cursor, path, nextActive);
      } else if (array && structs.has(array.type)) {
        const element = structs.get(array.type)!;
        const elementLayout = measureStruct(element, structs, policy, nextActive);
        const stride = policy.arrayStride(elementLayout.size, elementLayout.alignment);
        for (let index = 0; index < array.count; index++) {
          layoutStruct(
            element,
            baseOffset + cursor + index * stride,
            `${path}[${index}]`,
            nextActive
          );
        }
      } else {
        fields.push(
          Object.freeze({
            path,
            offset: baseOffset + cursor,
            size: layout.size,
            alignment: layout.alignment,
            ...(layout.stride === undefined ? {} : { stride: layout.stride }),
            scalarKind: layout.scalarKind,
            elementCount: layout.elementCount,
            shape: layout.shape as BufferFieldLayoutShape
          })
        );
      }
      cursor += layout.size;
      memberAlignment = Math.max(memberAlignment, layout.alignment);
    }
    const alignment = policy.structAlignment(memberAlignment);
    return {
      size: align(cursor, alignment),
      alignment,
      scalarKind: 'f32',
      elementCount: 1,
      shape: Object.freeze({ kind: 'struct' })
    };
  };

  const rootLayout = layoutStruct(root, 0, '', new Set());
  return finalizeBufferLayoutManifest(name, shaderAbiVersion, resolved, rootLayout, fields);
}

/**
 * Creates the complete ShaderBindingManifest describing bind groups, buffer layouts,
 * vertex inputs, and fragment outputs of a shader module.
 */
export function createShaderBindingManifest(
  ir: ShaderModuleIR,
  shaderAbiVersion: number,
  target: ShaderTarget = 'wgsl',
  options: ShaderBindingManifestOptions = {}
): ShaderBindingManifest {
  const visibility = bindingVisibility(ir);
  const structs = new Map(ir.types.map((type) => [type.name, type]));
  const requirements = indexBindingRequirements(options.bindingRequirements ?? []);
  const grouped = new Map<number, ShaderBindingEntryManifest[]>();
  const reflectedBindings = new Set<string>();
  const buffers: BufferLayoutManifest[] = [];
  for (const global of ir.globals) {
    if (global.group === undefined || global.binding === undefined) continue;
    const key = bindingKey(global.group, global.binding);
    if (reflectedBindings.has(key)) {
      throw reflectionError(
        'duplicate-reflected-binding',
        global.group,
        global.binding,
        'Shader reflection contains duplicate group and binding coordinates.',
        global.name,
        global.type
      );
    }
    reflectedBindings.add(key);
    const requirement = requirements.get(key);
    const entry = reflectBindingEntry(
      global.group,
      global.binding,
      global.name,
      global.type,
      global.addressSpace,
      requirement
    );
    const entries = grouped.get(global.group) ?? [];
    entries.push(entry);
    grouped.set(global.group, entries);
    requirements.delete(key);
    if (global.addressSpace === 'uniform' || global.addressSpace === 'storage') {
      const policy = selectShaderLayoutPolicy(target, global.addressSpace);
      buffers.push(
        createBoundBufferLayoutManifest(
          global,
          structs.get(global.type),
          ir.types,
          shaderAbiVersion,
          {
            policy: policy.id,
            target,
            addressSpace: global.addressSpace,
            access: global.access
          }
        )
      );
    }
  }
  const missingRequirement = requirements.values().next().value as
    ShaderSamplerBindingRequirement | undefined;
  if (missingRequirement !== undefined) {
    throw reflectionError(
      'missing-binding-requirement-target',
      missingRequirement.group,
      missingRequirement.binding,
      'Binding requirement does not target a reflected shader binding.'
    );
  }
  buffers.sort(
    (left, right) =>
      compareCodeUnits(left.name, right.name) || compareCodeUnits(left.layoutHash, right.layoutHash)
  );
  const groups: BindingGroupManifest[] = [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([group, entries]) =>
      Object.freeze({
        group,
        visibility,
        entries: Object.freeze(entries.sort((left, right) => left.binding - right.binding))
      })
    );
  const vertexInputs = ir.globals
    .filter((value) => value.addressSpace === 'in' && value.location !== undefined)
    .map((value) =>
      Object.freeze({ location: value.location!, name: value.name, type: value.type })
    )
    .sort(compareStageIo);
  const fragmentOutputs = ir.globals
    .filter((value) => value.addressSpace === 'out' && value.location !== undefined)
    .map((value) =>
      Object.freeze({ location: value.location!, name: value.name, type: value.type })
    )
    .sort(compareStageIo);
  const data = { shaderAbiVersion, target, groups, buffers, vertexInputs, fragmentOutputs };
  return Object.freeze({
    shaderAbiVersion,
    groups: Object.freeze(groups),
    buffers: Object.freeze(buffers),
    vertexInputs: Object.freeze(vertexInputs),
    fragmentOutputs: Object.freeze(fragmentOutputs),
    layoutHash: stableHash(data)
  });
}

function bindingVisibility(ir: ShaderModuleIR): readonly ShaderStage[] {
  const stages = new Set(ir.entryPoints.map(({ stage }) => stage));
  if (stages.size === 0) return Object.freeze(['vertex', 'fragment']);
  return Object.freeze(
    (['vertex', 'fragment', 'compute'] as const).filter((stage) => stages.has(stage))
  );
}

function createBoundBufferLayoutManifest(
  global: ShaderGlobalIR,
  struct: ShaderStructTypeIR | undefined,
  types: readonly ShaderStructTypeIR[],
  shaderAbiVersion: number,
  options: BufferLayoutOptions
): BufferLayoutManifest {
  if (struct !== undefined) {
    return createBufferLayoutManifest(global.name, struct, types, shaderAbiVersion, options);
  }
  const resolved = resolveBufferLayoutOptions(options);
  const rootLayout = measureType(
    global.type,
    new Map(types.map((type) => [type.name, type])),
    resolved.policy,
    new Set()
  );
  const rootField = Object.freeze({
    path: ROOT_BUFFER_FIELD_PATH,
    offset: 0,
    size: rootLayout.size,
    alignment: rootLayout.alignment,
    ...(rootLayout.stride === undefined ? {} : { stride: rootLayout.stride }),
    scalarKind: rootLayout.scalarKind,
    elementCount: rootLayout.elementCount,
    shape: rootLayout.shape as BufferFieldLayoutShape
  });
  return finalizeBufferLayoutManifest(global.name, shaderAbiVersion, resolved, rootLayout, [
    rootField
  ]);
}

function resolveBufferLayoutOptions(options: BufferLayoutOptions): ResolvedBufferLayoutOptions {
  const policy = options.policy
    ? shaderLayoutPolicy(options.policy)
    : selectShaderLayoutPolicy(options.target ?? 'wgsl', options.addressSpace ?? 'uniform');
  const target = options.target ?? policy.target;
  const addressSpace = options.addressSpace ?? policy.addressSpace;
  if (target !== policy.target || addressSpace !== policy.addressSpace) {
    throw new Error(`Shader layout policy ${policy.id} does not match ${target}/${addressSpace}.`);
  }
  const access = options.access ?? 'read';
  if (addressSpace === 'uniform' && access !== 'read') {
    throw new Error('Uniform buffer layouts are read-only.');
  }
  return Object.freeze({ policy, target, addressSpace, access });
}

function finalizeBufferLayoutManifest(
  name: string,
  shaderAbiVersion: number,
  options: ResolvedBufferLayoutOptions,
  rootLayout: TypeLayout,
  fields: readonly BufferFieldLayout[]
): BufferLayoutManifest {
  const frozenFields = Object.freeze(
    [...fields].sort(
      (left, right) => left.offset - right.offset || left.path.localeCompare(right.path)
    )
  );
  const metadata = Object.freeze({
    name,
    shaderAbiVersion,
    target: options.target,
    addressSpace: options.addressSpace,
    access: options.access,
    policy: options.policy.id,
    byteSize: rootLayout.size,
    alignment: rootLayout.alignment,
    fields: frozenFields
  });
  return Object.freeze({ ...metadata, layoutHash: stableHash(metadata) });
}

function compareStageIo(
  left: Readonly<{ location: number; name: string; type: string }>,
  right: Readonly<{ location: number; name: string; type: string }>
): number {
  return (
    left.location - right.location ||
    compareCodeUnits(left.name, right.name) ||
    compareCodeUnits(left.type, right.type)
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function measureStruct(
  struct: ShaderStructTypeIR,
  structs: ReadonlyMap<string, ShaderStructTypeIR>,
  policy: ShaderLayoutPolicy,
  active: ReadonlySet<string>
): TypeLayout {
  if (active.has(struct.name)) throw recursiveStructError(active, struct.name);
  const nextActive = new Set(active).add(struct.name);
  let cursor = 0;
  let memberAlignment = 1;
  for (const field of struct.fields) {
    const nested = structs.get(field.type);
    const layout = nested
      ? measureStruct(nested, structs, policy, nextActive)
      : measureType(field.type, structs, policy, nextActive);
    cursor = align(cursor, layout.alignment) + layout.size;
    memberAlignment = Math.max(memberAlignment, layout.alignment);
  }
  const alignment = policy.structAlignment(memberAlignment);
  return {
    size: align(cursor, alignment),
    alignment,
    scalarKind: 'f32',
    elementCount: 1,
    shape: Object.freeze({ kind: 'struct' })
  };
}

/**
 * Computes sizes, alignments, and strides for scalar types, vectors, matrices, and arrays.
 * Follows layout standard rules:
 * - vec2 is aligned to 8 bytes, vec3 and vec4 are aligned to 16 bytes.
 * - matrices are measured column-by-column (with strides calculated according to target policy).
 * - arrays element layout strides are rounded up to element alignment.
 */
function measureType(
  type: string,
  structs: ReadonlyMap<string, ShaderStructTypeIR>,
  policy: ShaderLayoutPolicy,
  active: ReadonlySet<string>
): TypeLayout {
  const normalized = type.replace(/\s+/g, '');
  if (normalized === 'f32') return scalar('f32');
  if (normalized === 'i32') return scalar('i32');
  if (normalized === 'u32') return scalar('u32');
  if (normalized === 'bool' || normalized === 'bool32') return scalar('bool32');
  const vector = /^vec([234])<(f32|i32|u32|bool)>$/.exec(normalized);
  if (vector) {
    const count = Number(vector[1]);
    return {
      size: count * 4,
      alignment: count === 2 ? 8 : 16,
      scalarKind: scalarKind(vector[2]!),
      elementCount: count,
      shape: Object.freeze({ kind: 'vector', length: count as 2 | 3 | 4 })
    };
  }
  const matrix = /^mat([234])x([234])<f32>$/.exec(normalized);
  if (matrix) {
    const columns = Number(matrix[1]);
    const rows = Number(matrix[2]);
    const stride = policy.matrixColumnStride(rows);
    return {
      size: columns * stride,
      alignment: stride,
      stride,
      scalarKind: 'f32',
      elementCount: columns * rows,
      shape: Object.freeze({
        kind: 'matrix',
        columns: columns as 2 | 3 | 4,
        rows: rows as 2 | 3 | 4,
        columnStride: stride
      })
    };
  }
  const array = arrayElement(normalized);
  if (array) {
    const struct = structs.get(array.type);
    const element = struct
      ? measureStruct(struct, structs, policy, active)
      : measureType(array.type, structs, policy, active);
    const alignment = policy.arrayAlignment(element.alignment);
    const stride = policy.arrayStride(element.size, element.alignment);
    return {
      size: stride * array.count,
      alignment,
      stride,
      scalarKind: element.scalarKind,
      elementCount: array.count * element.elementCount,
      shape: Object.freeze({
        kind: 'array',
        length: array.count,
        stride,
        element: element.shape as BufferFieldLayoutShape
      })
    };
  }
  throw new Error(`Unsupported shader ABI type "${type}".`);
}

function recursiveStructError(active: ReadonlySet<string>, name: string): Error {
  return new Error(`Recursive shader ABI struct cycle: ${[...active, name].join(' -> ')}.`);
}

function arrayElement(type: string): { readonly type: string; readonly count: number } | undefined {
  const match = /^array<(.+),(\d+)>$/.exec(type.replace(/\s+/g, ''));
  return match ? { type: match[1]!, count: Number(match[2]) } : undefined;
}

function scalar(kind: ShaderScalarKind): TypeLayout {
  return {
    size: 4,
    alignment: 4,
    scalarKind: kind,
    elementCount: 1,
    shape: Object.freeze({ kind: 'scalar' })
  };
}

function scalarKind(kind: string): ShaderScalarKind {
  return kind === 'bool' ? 'bool32' : (kind as ShaderScalarKind);
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
