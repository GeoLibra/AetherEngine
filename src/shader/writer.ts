import type { BufferFieldLayout, BufferLayoutManifest } from './types';

export class ShaderParameterWriter {
  private readonly fields: ReadonlyMap<string, BufferFieldLayout>;
  private readonly view: DataView;
  constructor(
    readonly manifest: BufferLayoutManifest,
    readonly buffer: ArrayBuffer
  ) {
    if (buffer.byteLength < manifest.byteSize)
      throw new Error(`Shader parameter buffer requires ${manifest.byteSize} bytes.`);
    this.fields = new Map(manifest.fields.map((field) => [field.path, field]));
    this.view = new DataView(buffer);
  }
  write(path: string, value: number | boolean | readonly number[]): void {
    const field = this.fields.get(path);
    if (!field) throw new Error(`Unknown shader field "${path}".`);
    const values = Array.isArray(value)
      ? value
      : [typeof value === 'boolean' ? (value ? 1 : 0) : value];
    if (values.length > field.elementCount)
      throw new Error(
        `Shader field "${path}" accepts at most ${field.elementCount} scalar values.`
      );
    for (let index = 0; index < values.length; index++) {
      const offset = field.offset + scalarOffset(field, index);
      const scalar = values[index]!;
      if (field.scalarKind === 'f32') this.view.setFloat32(offset, scalar, true);
      else if (field.scalarKind === 'i32') this.view.setInt32(offset, scalar, true);
      else
        this.view.setUint32(
          offset,
          field.scalarKind === 'bool32' ? (scalar ? 1 : 0) : scalar,
          true
        );
    }
  }
}

function scalarOffset(field: BufferFieldLayout, index: number): number {
  if (field.stride !== undefined && field.elementCount > 1) {
    const scalarsPerStride = Math.max(
      1,
      field.size / field.stride === field.elementCount
        ? 1
        : Math.floor(field.elementCount / (field.size / field.stride))
    );
    return Math.floor(index / scalarsPerStride) * field.stride + (index % scalarsPerStride) * 4;
  }
  return index * 4;
}
