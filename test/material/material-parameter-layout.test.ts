import { describe, expect, test } from 'vitest';
import {
  MaterialDiagnosticError,
  compileMaterialParameterLayout,
  createMaterialParameterUploadRanges,
  createBufferLayoutManifest,
  createMaterialParameterBlock,
  defineMaterialSchema,
  writeMaterialParameters,
  UploadPlanner,
  uploadMaterialParameterRanges,
  type BufferLayoutManifest,
  type MaterialParameterBlock,
  type ShaderStructTypeIR
} from '../../src';
import { setMaterialParameterAtIndex } from '../../src/material/internal';

const ParameterStruct: ShaderStructTypeIR = {
  kind: 'struct',
  name: 'MaterialParameters',
  fields: [
    { name: 'roughness', type: 'f32' },
    { name: 'mask', type: 'u32' },
    { name: 'enabled', type: 'bool32' },
    { name: 'normal', type: 'vec3<f32>' },
    { name: 'basis', type: 'mat2x2<f32>' },
    { name: 'weights', type: 'array<f32, 3>' }
  ]
};

describe('Material parameter layout and writer', () => {
  test('writes an independent byte golden with exact scalar bits and padding', () => {
    const fixture = createParameterFixture();
    const block = createTypedBlock(fixture.defaults, fixture.schema);
    const write = writeMaterialParameters(fixture.layout, block);
    const expected = new Uint8Array(fixture.manifest.byteSize);
    const view = new DataView(expected.buffer);
    view.setFloat32(0, 1.5, true);
    view.setUint32(4, 0xffff_ffff, true);
    view.setUint32(8, 1, true);
    [1, -2, 3].forEach((value, index) => view.setFloat32(16 + index * 4, value, true));
    view.setFloat32(32, 1, true);
    view.setFloat32(36, 2, true);
    view.setFloat32(40, 3, true);
    view.setFloat32(44, 4, true);
    view.setFloat32(48, 0.25, true);
    view.setFloat32(64, 0.5, true);
    view.setFloat32(80, 0.75, true);

    expect(write.bytes).toEqual(expected);
    expect([...write.bytes.slice(12, 16)]).toEqual([0, 0, 0, 0]);
    expect([...write.bytes.slice(28, 32)]).toEqual([0, 0, 0, 0]);
    expect([...write.bytes.slice(52, 64)]).toEqual(new Array(12).fill(0));
    expect([...write.bytes.slice(68, 80)]).toEqual(new Array(12).fill(0));
    expect([...write.bytes.slice(84, 96)]).toEqual(new Array(12).fill(0));
    expect(write.dirtyRanges).toEqual([
      { offset: 0, byteLength: 12 },
      { offset: 16, byteLength: 12 },
      { offset: 32, byteLength: 64 }
    ]);
    expect(write.counters).toEqual({ resolvedFields: 6, writtenFields: 6, writtenBytes: 88 });
  });

  test('typed, authoring-name and internal-index blocks produce identical bytes and ranges', () => {
    const fixture = createParameterFixture();
    const blocks = [
      createTypedBlock(fixture.defaults, fixture.schema),
      createNamedBlock(fixture.defaults),
      createIndexedBlock(fixture.defaults, fixture.schema)
    ];
    const writes = blocks.map((block) => writeMaterialParameters(fixture.layout, block));

    expect(writes[1]?.bytes).toEqual(writes[0]?.bytes);
    expect(writes[2]?.bytes).toEqual(writes[0]?.bytes);
    expect(writes[1]?.dirtyRanges).toEqual(writes[0]?.dirtyRanges);
    expect(writes[2]?.dirtyRanges).toEqual(writes[0]?.dirtyRanges);
  });

  test('reports only the changed reflected range and no range for unchanged values', () => {
    const fixture = createParameterFixture();
    const firstBlock = createTypedBlock(fixture.defaults, fixture.schema);
    const first = writeMaterialParameters(fixture.layout, firstBlock);
    const changedBlock = firstBlock.with(fixture.schema.fields.normal, [9, 8, 7]);
    const changed = writeMaterialParameters(fixture.layout, changedBlock, first);

    expect(changed.dirtyRanges).toEqual([{ offset: 16, byteLength: 12 }]);
    expect(changed.counters).toEqual({ resolvedFields: 6, writtenFields: 1, writtenBytes: 12 });
    expect(new Float32Array(changed.bytes.buffer, 16, 3)).toEqual(new Float32Array([9, 8, 7]));

    const unchanged = writeMaterialParameters(fixture.layout, changedBlock, changed);
    expect(unchanged.bytes).toEqual(changed.bytes);
    expect(unchanged.dirtyRanges).toEqual([]);
    expect(unchanged.counters).toEqual({ resolvedFields: 6, writtenFields: 0, writtenBytes: 0 });
  });

  test('exports detached dirty payloads at the destination buffer offset', () => {
    const fixture = createParameterFixture();
    const first = writeMaterialParameters(
      fixture.layout,
      createTypedBlock(fixture.defaults, fixture.schema)
    );
    const changed = writeMaterialParameters(
      fixture.layout,
      createTypedBlock(fixture.defaults, fixture.schema).with(
        fixture.schema.fields.normal,
        [9, 8, 7]
      ),
      first
    );

    const ranges = createMaterialParameterUploadRanges(changed, 256);

    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.offset).toBe(272);
    expect(new Float32Array((ranges[0]?.data as Uint8Array).buffer)).toEqual(
      new Float32Array([9, 8, 7])
    );
    (ranges[0]?.data as Uint8Array)[0] = 0xff;
    expect(
      new Float32Array(
        (createMaterialParameterUploadRanges(changed, 256)[0]!.data as Uint8Array).buffer
      )
    ).toEqual(new Float32Array([9, 8, 7]));
    expect(() => createMaterialParameterUploadRanges(changed, -1)).toThrow(
      'baseOffset must be a non-negative safe integer'
    );
  });

  test('submits all material dirty ranges only after planner admission and rolls back a deferred batch', async () => {
    const fixture = createParameterFixture();
    const first = writeMaterialParameters(
      fixture.layout,
      createTypedBlock(fixture.defaults, fixture.schema)
    );
    const changed = writeMaterialParameters(
      fixture.layout,
      createTypedBlock(fixture.defaults, fixture.schema).with(
        fixture.schema.fields.normal,
        [9, 8, 7]
      ),
      first
    );
    const { NullDevice } = await import('../../src');
    const device = new NullDevice();
    const buffer = device.createBuffer({ size: 512, usage: 1 << 3 });
    const planner = new UploadPlanner({
      capacityBytes: 64,
      maxFrameBytes: 64,
      maxFrameCommands: 2,
      alignment: 16
    });
    planner.beginFrame(1);

    const uploaded = uploadMaterialParameterRanges(planner, device.queue, buffer, changed, 256);
    expect(uploaded).toEqual(
      expect.objectContaining({ status: 'written', rangeCount: 1, byteLength: 12 })
    );
    await buffer.mapAsync(0);
    expect(new Float32Array(buffer.getMappedRange(272, 12))).toEqual(new Float32Array([9, 8, 7]));
    buffer.unmap();
    expect(device.queue.metrics()).toMatchObject({ uploadCalls: 1, uploadBytes: 12 });
    if (uploaded.status !== 'written') throw new Error('Expected budgeted material write.');
    const submission = device.queue.submit([]);
    for (const reservation of uploaded.reservations) planner.retireAfter(reservation, submission);
    await submission.done;
    await Promise.resolve();
    expect(planner.snapshot()).toMatchObject({ liveBytes: 0, allocatedBytes: 12 });

    const deferredPlanner = new UploadPlanner({
      capacityBytes: 256,
      maxFrameBytes: 256,
      maxFrameCommands: 1,
      alignment: 16
    });
    deferredPlanner.beginFrame(1);
    expect(uploadMaterialParameterRanges(deferredPlanner, device.queue, buffer, first)).toEqual({
      status: 'deferred',
      reason: 'frame-command-budget'
    });
    expect(deferredPlanner.snapshot()).toMatchObject({
      allocatedBytes: 0,
      allocatedCommands: 0,
      reservedBytes: 0,
      liveBytes: 0
    });
  });

  test('merges adjacent and overlapping reflected byte intervals deterministically', () => {
    const schema = defineMaterialSchema({
      id: 'aether.material.overlapping-ranges',
      version: 1,
      fields: {
        first: numberField('first'),
        second: numberField('second')
      }
    });
    const manifest = manualManifest([
      {
        path: 'first',
        offset: 0,
        size: 8,
        alignment: 4,
        scalarKind: 'f32',
        elementCount: 1,
        shape: { kind: 'scalar' }
      },
      {
        path: 'second',
        offset: 4,
        size: 8,
        alignment: 4,
        scalarKind: 'f32',
        elementCount: 1,
        shape: { kind: 'scalar' }
      }
    ]);
    const layout = compileMaterialParameterLayout(schema, manifest);
    const block = createMaterialParameterBlock(schema)
      .with(schema.fields.first, 1)
      .with(schema.fields.second, 2);

    expect(writeMaterialParameters(layout, block).dirtyRanges).toEqual([
      { offset: 0, byteLength: 12 }
    ]);
  });

  test('diagnoses missing paths and incompatible reflected scalar shapes at compile time', () => {
    const missingSchema = defineMaterialSchema({
      id: 'aether.material.missing-parameter',
      version: 1,
      fields: { value: numberField('notPresent') }
    });
    expectCompileDiagnostic(
      () =>
        compileMaterialParameterLayout(
          missingSchema,
          createBufferLayoutManifest('Parameters', ParameterStruct, [ParameterStruct], 1)
        ),
      'missing-binding'
    );

    const shapeSchema = defineMaterialSchema({
      id: 'aether.material.bad-parameter-shape',
      version: 1,
      fields: {
        normal: {
          fieldId: 'normal',
          name: 'normal',
          valueType: { kind: 'vector', length: 4, format: 'f32' },
          defaultValue: [0, 0, 0, 0],
          bindingPath: 'normal'
        }
      }
    });
    expectCompileDiagnostic(
      () =>
        compileMaterialParameterLayout(
          shapeSchema,
          createBufferLayoutManifest('Parameters', ParameterStruct, [ParameterStruct], 1)
        ),
      'type-mismatch'
    );

    const crossShapeSchema = defineMaterialSchema({
      id: 'aether.material.cross-parameter-shape',
      version: 1,
      fields: {
        values: {
          fieldId: 'values',
          name: 'values',
          valueType: { kind: 'vector', length: 4, format: 'f32' },
          defaultValue: [0, 0, 0, 0],
          bindingPath: 'values'
        }
      }
    });
    const ArrayStruct: ShaderStructTypeIR = {
      kind: 'struct',
      name: 'ArrayShape',
      fields: [{ name: 'values', type: 'array<f32, 4>' }]
    };
    expectCompileDiagnostic(
      () =>
        compileMaterialParameterLayout(
          crossShapeSchema,
          createBufferLayoutManifest('ArrayShape', ArrayStruct, [ArrayStruct], 1)
        ),
      'type-mismatch'
    );
  });

  test('owns a normalized previous snapshot instead of propagating caller byte mutation', () => {
    const fixture = createParameterFixture();
    const block = createTypedBlock(fixture.defaults, fixture.schema);
    const first = writeMaterialParameters(fixture.layout, block);
    first.bytes[0] = 0xff;
    first.bytes[12] = 0xff;
    expect(first.bytes[0]).toBe(new DataView(first.bytes.buffer).getUint8(0));
    expect(first.bytes[0]).toBe(0);
    expect(first.bytes[12]).toBe(0);

    const next = writeMaterialParameters(fixture.layout, block, first);

    expect(new DataView(next.bytes.buffer).getFloat32(0, true)).toBe(1.5);
    expect(next.bytes[12]).toBe(0);
    expect(next.dirtyRanges).toEqual([]);
    expect(next.counters).toEqual({ resolvedFields: 6, writtenFields: 0, writtenBytes: 0 });
  });

  test('deep snapshots the required reflected manifest and field facts', () => {
    const schema = defineMaterialSchema({
      id: 'aether.material.manifest-snapshot',
      version: 1,
      fields: { value: numberField('value') }
    });
    const mutableField = {
      path: 'value',
      offset: 0,
      size: 4,
      alignment: 4,
      scalarKind: 'f32' as const,
      elementCount: 1,
      shape: { kind: 'scalar' as const }
    };
    const mutableManifest = manualManifest([mutableField]);
    const layout = compileMaterialParameterLayout(schema, mutableManifest);
    mutableField.offset = 8;

    const write = writeMaterialParameters(
      layout,
      createMaterialParameterBlock(schema).with(schema.fields.value, 1.5)
    );

    expect(layout.bufferManifest).not.toBe(mutableManifest);
    expect(layout.fields[0]?.bufferField).not.toBe(mutableField);
    expect(layout.fields[0]?.bufferField.offset).toBe(0);
    expect(Object.isFrozen(layout.bufferManifest.fields[0]?.shape)).toBe(true);
    expect(new DataView(write.bytes.buffer).getFloat32(0, true)).toBe(1.5);
    expect(new DataView(write.bytes.buffer).getUint32(8, true)).toBe(0);
  });
});

function createParameterFixture() {
  const schema = defineMaterialSchema({
    id: 'aether.material.parameter-golden',
    version: 1,
    fields: {
      roughness: numberField('roughness'),
      mask: {
        fieldId: 'mask',
        name: 'mask',
        valueType: { kind: 'number', format: 'u32' },
        defaultValue: 0,
        bindingPath: 'mask'
      },
      enabled: {
        fieldId: 'enabled',
        name: 'enabled',
        valueType: { kind: 'boolean' },
        defaultValue: false,
        bindingPath: 'enabled'
      },
      normal: {
        fieldId: 'normal',
        name: 'normal',
        valueType: { kind: 'vector', length: 3, format: 'f32' },
        defaultValue: [0, 0, 0],
        bindingPath: 'normal'
      },
      basis: {
        fieldId: 'basis',
        name: 'basis',
        valueType: { kind: 'matrix', columns: 2, rows: 2 },
        defaultValue: [0, 0, 0, 0],
        bindingPath: 'basis'
      },
      weights: {
        fieldId: 'weights',
        name: 'weights',
        valueType: {
          kind: 'array',
          element: { kind: 'number', format: 'f32' },
          length: 3
        },
        defaultValue: [0, 0, 0],
        bindingPath: 'weights'
      }
    }
  });
  const manifest = createBufferLayoutManifest(
    'MaterialParameters',
    ParameterStruct,
    [ParameterStruct],
    1
  );
  return {
    schema,
    manifest,
    layout: compileMaterialParameterLayout(schema, manifest),
    defaults: createMaterialParameterBlock(schema)
  };
}

function createTypedBlock(
  block: MaterialParameterBlock,
  schema: ReturnType<typeof createParameterFixture>['schema']
): MaterialParameterBlock {
  return block
    .with(schema.fields.roughness, 1.5)
    .with(schema.fields.mask, 0xffff_ffff)
    .with(schema.fields.enabled, true)
    .with(schema.fields.normal, [1, -2, 3])
    .with(schema.fields.basis, [1, 2, 3, 4])
    .with(schema.fields.weights, [0.25, 0.5, 0.75]);
}

function createNamedBlock(block: MaterialParameterBlock): MaterialParameterBlock {
  return block
    .withName('roughness', 1.5)
    .withName('mask', 0xffff_ffff)
    .withName('enabled', true)
    .withName('normal', [1, -2, 3])
    .withName('basis', [1, 2, 3, 4])
    .withName('weights', [0.25, 0.5, 0.75]);
}

function createIndexedBlock(
  initial: MaterialParameterBlock,
  schema: ReturnType<typeof createParameterFixture>['schema']
): MaterialParameterBlock {
  const writes = [
    [schema.fields.roughness.index, 1.5],
    [schema.fields.mask.index, 0xffff_ffff],
    [schema.fields.enabled.index, true],
    [schema.fields.normal.index, [1, -2, 3]],
    [schema.fields.basis.index, [1, 2, 3, 4]],
    [schema.fields.weights.index, [0.25, 0.5, 0.75]]
  ] as const;
  return writes.reduce(
    (block, [index, value]) => setMaterialParameterAtIndex(block, index, value),
    initial
  );
}

function numberField(bindingPath: string) {
  return {
    fieldId: bindingPath,
    name: bindingPath,
    valueType: { kind: 'number', format: 'f32' } as const,
    defaultValue: 0,
    bindingPath
  };
}

function manualManifest(fields: BufferLayoutManifest['fields']): BufferLayoutManifest {
  return {
    name: 'Manual',
    shaderAbiVersion: 1,
    target: 'wgsl',
    addressSpace: 'uniform',
    access: 'read',
    policy: 'wgsl-uniform',
    byteSize: 16,
    alignment: 16,
    fields,
    layoutHash: 'manual-layout'
  };
}

function expectCompileDiagnostic(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error('Expected MaterialDiagnosticError.');
  } catch (error) {
    expect(error).toBeInstanceOf(MaterialDiagnosticError);
    expect((error as MaterialDiagnosticError).diagnostic.code).toBe(code);
  }
}
