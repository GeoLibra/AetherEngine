import { ShaderParameterWriter } from '../shader/writer';
import type {
  BufferFieldLayout,
  BufferFieldLayoutShape,
  BufferLayoutManifest,
  ShaderScalarKind
} from '../shader/types';
import { MaterialDiagnosticError } from './diagnostics';
import { getMaterialSchemaInternals } from './schema';
import type {
  MaterialDiagnosticCode,
  MaterialField,
  MaterialParameterBlock,
  MaterialSchema,
  MaterialValue,
  MaterialValueType
} from './types';

export interface MaterialDirtyRange {
  readonly offset: number;
  readonly byteLength: number;
}

export interface CompiledMaterialParameterField {
  readonly field: MaterialField;
  readonly fieldId: string;
  readonly fieldName: string;
  readonly bindingPath: string;
  readonly valueType: MaterialValueType;
  readonly bufferField: BufferFieldLayout;
}

export interface CompiledMaterialParameterLayout {
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly schemaFingerprint: string;
  readonly bufferLayoutHash: string;
  readonly byteSize: number;
  readonly fields: readonly CompiledMaterialParameterField[];
  readonly bufferManifest: BufferLayoutManifest;
}

export interface MaterialParameterWriteCounters {
  readonly resolvedFields: number;
  readonly writtenFields: number;
  readonly writtenBytes: number;
}

export interface MaterialParameterWrite {
  readonly layoutHash: string;
  readonly bytes: Uint8Array;
  readonly dirtyRanges: readonly MaterialDirtyRange[];
  readonly counters: Readonly<MaterialParameterWriteCounters>;
}

const PARAMETER_WRITE_BYTES = new WeakMap<MaterialParameterWrite, Uint8Array>();

type MaterialNumericShape =
  | Readonly<{ kind: 'scalar' }>
  | Readonly<{ kind: 'vector'; length: 2 | 3 | 4 }>
  | Readonly<{ kind: 'matrix'; columns: 2 | 3 | 4; rows: 2 | 3 | 4 }>
  | Readonly<{ kind: 'array'; length: number; element: MaterialNumericShape }>;

export function compileMaterialParameterLayout(
  schema: MaterialSchema,
  bufferManifest: BufferLayoutManifest
): CompiledMaterialParameterLayout {
  const ownedManifest = snapshotBufferManifest(bufferManifest);
  const bufferFields = indexBufferFields(ownedManifest);
  const schemaInternals = getMaterialSchemaInternals(schema);
  const fields = schemaInternals.definitions.flatMap((definition) => {
    const expected = numericTypeFacts(definition.valueType);
    if (expected === undefined) return [];
    const candidates = bufferFields.get(definition.bindingPath) ?? [];
    if (candidates.length === 0) {
      throw compileError(
        schema,
        'missing-binding',
        definition.name,
        `Material parameter path "${definition.bindingPath}" is missing from Shader reflection.`
      );
    }
    if (candidates.length > 1) {
      throw compileError(
        schema,
        'compile-failure',
        definition.name,
        `Material parameter path "${definition.bindingPath}" is ambiguous in Shader reflection.`
      );
    }
    const bufferField = candidates[0]!;
    if (
      bufferField.scalarKind !== expected.scalarKind ||
      bufferField.elementCount !== expected.elementCount ||
      !numericShapeMatches(expected.shape, bufferField.shape)
    ) {
      throw compileError(
        schema,
        'type-mismatch',
        definition.name,
        `Material parameter "${definition.name}" does not match its reflected scalar shape.`
      );
    }
    const field = schemaInternals.fieldsById.get(definition.fieldId);
    if (field === undefined) throw new Error('Material schema field token is missing.');
    return [
      Object.freeze({
        field,
        fieldId: definition.fieldId,
        fieldName: definition.name,
        bindingPath: definition.bindingPath,
        valueType: definition.valueType,
        bufferField
      })
    ];
  });
  return Object.freeze({
    schemaId: schema.id,
    schemaVersion: schema.version,
    schemaFingerprint: schema.fingerprint,
    bufferLayoutHash: ownedManifest.layoutHash,
    byteSize: ownedManifest.byteSize,
    fields: Object.freeze(fields),
    bufferManifest: ownedManifest
  });
}

export function writeMaterialParameters(
  layout: CompiledMaterialParameterLayout,
  block: MaterialParameterBlock,
  previous?: MaterialParameterWrite
): MaterialParameterWrite {
  validateBlock(layout, block);
  if (previous !== undefined && previous.layoutHash !== layout.bufferLayoutHash) {
    throw new Error('Previous material parameter write uses another buffer layout.');
  }
  const previousBytes = previous === undefined ? undefined : PARAMETER_WRITE_BYTES.get(previous);
  if (previous !== undefined && previousBytes === undefined) {
    throw new Error('Previous material parameter write is not an owned snapshot.');
  }
  const bytes = new Uint8Array(layout.byteSize);
  if (previousBytes !== undefined) {
    if (previousBytes.byteLength !== layout.byteSize) {
      throw new Error('Previous material parameter byte length does not match the layout.');
    }
    bytes.set(previousBytes);
  }
  const writer = new ShaderParameterWriter(layout.bufferManifest, bytes.buffer);
  const dirtyRanges: MaterialDirtyRange[] = [];
  let writtenFields = 0;
  for (const field of layout.fields) {
    const before = previousBytes;
    bytes.fill(0, field.bufferField.offset, field.bufferField.offset + field.bufferField.size);
    const value = writerValue(block.get(field.field), field.valueType, field.fieldName);
    writer.write(field.bindingPath, value);
    if (
      before === undefined ||
      !rangeEqual(before, bytes, field.bufferField.offset, field.bufferField.size)
    ) {
      writtenFields += 1;
      dirtyRanges.push({ offset: field.bufferField.offset, byteLength: field.bufferField.size });
    }
  }
  const mergedRanges = mergeDirtyRanges(dirtyRanges);
  const writtenBytes = mergedRanges.reduce((total, range) => total + range.byteLength, 0);
  const result = Object.freeze({
    layoutHash: layout.bufferLayoutHash,
    bytes,
    dirtyRanges: mergedRanges,
    counters: Object.freeze({
      resolvedFields: layout.fields.length,
      writtenFields,
      writtenBytes
    })
  });
  PARAMETER_WRITE_BYTES.set(result, bytes.slice());
  return result;
}

function indexBufferFields(
  manifest: BufferLayoutManifest
): ReadonlyMap<string, readonly BufferFieldLayout[]> {
  const indexed = new Map<string, BufferFieldLayout[]>();
  for (const field of manifest.fields) {
    const candidates = indexed.get(field.path) ?? [];
    candidates.push(field);
    indexed.set(field.path, candidates);
  }
  return indexed;
}

function numericTypeFacts(type: MaterialValueType):
  | Readonly<{
      scalarKind: ShaderScalarKind;
      elementCount: number;
      shape: MaterialNumericShape;
    }>
  | undefined {
  switch (type.kind) {
    case 'number':
      return { scalarKind: type.format, elementCount: 1, shape: { kind: 'scalar' } };
    case 'boolean':
      return { scalarKind: 'bool32', elementCount: 1, shape: { kind: 'scalar' } };
    case 'vector':
      return {
        scalarKind: type.format,
        elementCount: type.length,
        shape: { kind: 'vector', length: type.length }
      };
    case 'matrix':
      return {
        scalarKind: 'f32',
        elementCount: type.columns * type.rows,
        shape: { kind: 'matrix', columns: type.columns, rows: type.rows }
      };
    case 'array': {
      const element = numericTypeFacts(type.element);
      return element === undefined
        ? undefined
        : {
            scalarKind: element.scalarKind,
            elementCount: element.elementCount * type.length,
            shape: { kind: 'array', length: type.length, element: element.shape }
          };
    }
    case 'texture-reference':
    case 'sampler-reference':
      return undefined;
  }
}

function numericShapeMatches(
  material: MaterialNumericShape,
  reflected: BufferFieldLayoutShape
): boolean {
  if (material.kind !== reflected.kind) return false;
  switch (material.kind) {
    case 'scalar':
      return true;
    case 'vector':
      return reflected.kind === 'vector' && material.length === reflected.length;
    case 'matrix':
      return (
        reflected.kind === 'matrix' &&
        material.columns === reflected.columns &&
        material.rows === reflected.rows
      );
    case 'array':
      return (
        reflected.kind === 'array' &&
        material.length === reflected.length &&
        numericShapeMatches(material.element, reflected.element)
      );
  }
}

function snapshotBufferManifest(manifest: BufferLayoutManifest): BufferLayoutManifest {
  return Object.freeze({
    name: manifest.name,
    shaderAbiVersion: manifest.shaderAbiVersion,
    target: manifest.target,
    addressSpace: manifest.addressSpace,
    access: manifest.access,
    policy: manifest.policy,
    byteSize: manifest.byteSize,
    alignment: manifest.alignment,
    fields: Object.freeze(manifest.fields.map(snapshotBufferField)),
    layoutHash: manifest.layoutHash
  });
}

function snapshotBufferField(field: BufferFieldLayout): BufferFieldLayout {
  return Object.freeze({
    path: field.path,
    offset: field.offset,
    size: field.size,
    alignment: field.alignment,
    ...(field.stride === undefined ? {} : { stride: field.stride }),
    scalarKind: field.scalarKind,
    elementCount: field.elementCount,
    shape: snapshotBufferShape(field.shape)
  });
}

function snapshotBufferShape(shape: BufferFieldLayoutShape): BufferFieldLayoutShape {
  switch (shape.kind) {
    case 'scalar':
      return Object.freeze({ kind: shape.kind });
    case 'vector':
      return Object.freeze({ kind: shape.kind, length: shape.length });
    case 'matrix':
      return Object.freeze({
        kind: shape.kind,
        columns: shape.columns,
        rows: shape.rows,
        columnStride: shape.columnStride
      });
    case 'array':
      return Object.freeze({
        kind: shape.kind,
        length: shape.length,
        stride: shape.stride,
        element: snapshotBufferShape(shape.element)
      });
  }
}

function writerValue(
  value: MaterialValue,
  type: MaterialValueType,
  fieldName: string
): number | boolean | readonly number[] {
  if (type.kind === 'number' && typeof value === 'number') return value;
  if (type.kind === 'boolean' && typeof value === 'boolean') return value;
  const values = flattenNumericValue(value);
  const expected = numericTypeFacts(type)?.elementCount;
  if (expected === undefined || values === undefined || values.length !== expected) {
    throw new Error(`Material parameter "${fieldName}" has an invalid scalar shape.`);
  }
  return values;
}

function flattenNumericValue(value: MaterialValue): readonly number[] | undefined {
  if (typeof value === 'number') return [value];
  if (!Array.isArray(value)) return undefined;
  const flattened: number[] = [];
  for (const element of value) {
    const values = flattenNumericValue(element);
    if (values === undefined) return undefined;
    flattened.push(...values);
  }
  return flattened;
}

function mergeDirtyRanges(ranges: readonly MaterialDirtyRange[]): readonly MaterialDirtyRange[] {
  const sorted = [...ranges].sort(
    (left, right) => left.offset - right.offset || left.byteLength - right.byteLength
  );
  const merged: MaterialDirtyRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous === undefined || previous.offset + previous.byteLength < range.offset) {
      merged.push(Object.freeze({ ...range }));
      continue;
    }
    const end = Math.max(previous.offset + previous.byteLength, range.offset + range.byteLength);
    merged[merged.length - 1] = Object.freeze({
      offset: previous.offset,
      byteLength: end - previous.offset
    });
  }
  return Object.freeze(merged);
}

function rangeEqual(
  left: Uint8Array,
  right: Uint8Array,
  offset: number,
  byteLength: number
): boolean {
  for (let index = offset; index < offset + byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function validateBlock(
  layout: CompiledMaterialParameterLayout,
  block: MaterialParameterBlock
): void {
  if (
    String(block.schemaId) !== layout.schemaId ||
    Number(block.schemaVersion) !== layout.schemaVersion ||
    block.fingerprint !== layout.schemaFingerprint
  ) {
    throw new MaterialDiagnosticError({
      code: 'schema-mismatch',
      schemaId: layout.schemaId,
      schemaVersion: layout.schemaVersion,
      message: 'Material parameter block does not match the compiled layout.'
    });
  }
}

function compileError(
  schema: MaterialSchema,
  code: Extract<MaterialDiagnosticCode, 'missing-binding' | 'compile-failure' | 'type-mismatch'>,
  field: string,
  message: string
): MaterialDiagnosticError {
  return new MaterialDiagnosticError({
    code,
    schemaId: schema.id,
    schemaVersion: schema.version,
    field,
    message
  });
}
