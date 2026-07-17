import { stableHash } from './hash';
import {
  selectShaderLayoutPolicy,
  shaderLayoutPolicy,
  type ShaderLayoutPolicy,
  type ShaderLayoutPolicyId
} from './layout-policy';
import type {
  BindingGroupManifest,
  BufferFieldLayout,
  BufferLayoutManifest,
  ShaderBindingManifest,
  ShaderModuleIR,
  ShaderScalarKind,
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
}

export interface BufferLayoutOptions {
  readonly policy?: ShaderLayoutPolicyId;
  readonly target?: ShaderTarget;
  readonly addressSpace?: 'uniform' | 'storage';
  readonly access?: 'read' | 'read_write';
}

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
            elementCount: layout.elementCount
          })
        );
      }
      cursor += layout.size;
      memberAlignment = Math.max(memberAlignment, layout.alignment);
    }
    const alignment = policy.structAlignment(memberAlignment);
    return { size: align(cursor, alignment), alignment, scalarKind: 'f32', elementCount: 1 };
  };

  const rootLayout = layoutStruct(root, 0, '', new Set());
  const frozenFields = Object.freeze(
    fields.sort((left, right) => left.offset - right.offset || left.path.localeCompare(right.path))
  );
  const metadata = Object.freeze({
    name,
    shaderAbiVersion,
    target,
    addressSpace,
    access,
    policy: policy.id,
    byteSize: rootLayout.size,
    alignment: rootLayout.alignment,
    fields: frozenFields
  });
  return Object.freeze({ ...metadata, layoutHash: stableHash(metadata) });
}

/**
 * Creates the complete ShaderBindingManifest describing bind groups, buffer layouts,
 * vertex inputs, and fragment outputs of a shader module.
 */
export function createShaderBindingManifest(
  ir: ShaderModuleIR,
  shaderAbiVersion: number,
  target: ShaderTarget = 'wgsl'
): ShaderBindingManifest {
  const structs = new Map(ir.types.map((type) => [type.name, type]));
  const grouped = new Map<number, Array<{ binding: number; name: string; kind: string }>>();
  const buffers: BufferLayoutManifest[] = [];
  for (const global of ir.globals) {
    if (global.group === undefined || global.binding === undefined) continue;
    const kind =
      global.addressSpace === 'uniform'
        ? 'uniform-buffer'
        : global.addressSpace === 'storage'
          ? 'storage-buffer'
          : global.type.startsWith('texture')
            ? 'texture'
            : global.type.startsWith('sampler')
              ? 'sampler'
              : 'resource';
    const entries = grouped.get(global.group) ?? [];
    entries.push(Object.freeze({ binding: global.binding, name: global.name, kind }));
    grouped.set(global.group, entries);
    const struct = structs.get(global.type);
    if (struct && (global.addressSpace === 'uniform' || global.addressSpace === 'storage')) {
      const policy = selectShaderLayoutPolicy(target, global.addressSpace);
      buffers.push(
        createBufferLayoutManifest(global.name, struct, ir.types, shaderAbiVersion, {
          policy: policy.id,
          target,
          addressSpace: global.addressSpace,
          access: global.access
        })
      );
    }
  }
  const groups: BindingGroupManifest[] = [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([group, entries]) =>
      Object.freeze({
        group,
        entries: Object.freeze(entries.sort((left, right) => left.binding - right.binding))
      })
    );
  const vertexInputs = ir.globals
    .filter((value) => value.addressSpace === 'in' && value.location !== undefined)
    .map((value) =>
      Object.freeze({ location: value.location!, name: value.name, type: value.type })
    );
  const fragmentOutputs = ir.globals
    .filter((value) => value.addressSpace === 'out' && value.location !== undefined)
    .map((value) =>
      Object.freeze({ location: value.location!, name: value.name, type: value.type })
    );
  const data = { target, groups, buffers, vertexInputs, fragmentOutputs };
  return Object.freeze({
    groups: Object.freeze(groups),
    buffers: Object.freeze(buffers),
    vertexInputs: Object.freeze(vertexInputs),
    fragmentOutputs: Object.freeze(fragmentOutputs),
    layoutHash: stableHash({ shaderAbiVersion, ...data })
  });
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
  return { size: align(cursor, alignment), alignment, scalarKind: 'f32', elementCount: 1 };
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
      elementCount: count
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
      elementCount: columns * rows
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
      elementCount: array.count * element.elementCount
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
  return { size: 4, alignment: 4, scalarKind: kind, elementCount: 1 };
}

function scalarKind(kind: string): ShaderScalarKind {
  return kind === 'bool' ? 'bool32' : (kind as ShaderScalarKind);
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
