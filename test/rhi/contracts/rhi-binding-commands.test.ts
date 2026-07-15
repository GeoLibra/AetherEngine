import { describe, expect, test } from 'vitest';
import { NullDevice } from '../../../src';

const BUFFER_USAGE_UNIFORM = 8;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 16;
const SHADER_STAGE_VERTEX = 1;
const SHADER_STAGE_FRAGMENT = 2;

function createPass(device: NullDevice) {
  const color = device.createTexture({
    label: 'color',
    size: { width: 4, height: 4 },
    format: 'rgba8unorm',
    usage: TEXTURE_USAGE_RENDER_ATTACHMENT
  });
  const target = device.createRenderTarget({
    label: 'target',
    width: 4,
    height: 4,
    colorAttachments: [
      {
        texture: color,
        format: 'rgba8unorm',
        loadOp: 'clear',
        storeOp: 'store'
      }
    ]
  });
  const encoder = device.createCommandEncoder();
  return { encoder, pass: encoder.beginRenderPass(target.createRenderPassDescriptor()) };
}

describe('RHI pass bind group commands', () => {
  test('records render pass setBindGroup with dynamic offsets', () => {
    const device = new NullDevice();
    const layout = device.createBindGroupLayout({
      label: 'frame-layout',
      entries: [
        {
          binding: 0,
          visibility: SHADER_STAGE_VERTEX,
          buffer: { type: 'uniform', hasDynamicOffset: true }
        }
      ]
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pipeline = device.createRenderPipeline({
      label: 'pipeline',
      layout: pipelineLayout,
      primitive: { topology: 'triangle-list' }
    });
    const buffer = device.createBuffer({ label: 'ubo', size: 64, usage: BUFFER_USAGE_UNIFORM });
    const bindGroup = device.createBindGroup({
      label: 'frame-bind-group',
      layout,
      entries: [{ binding: 0, resource: { buffer, size: 32 } }]
    });
    const { encoder, pass } = createPass(device);

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup, [16]);
    pass.end();

    expect(encoder.finish().getCommandStream()).toContainEqual({
      kind: 'setBindGroup',
      scope: 'render-pass',
      index: 0,
      bindGroup: { kind: 'bind-group', id: bindGroup.id, label: 'frame-bind-group' },
      dynamicOffsets: [16]
    });
  });

  test('validates dynamic offsets and pipeline layout compatibility', () => {
    const device = new NullDevice();
    const firstLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: SHADER_STAGE_VERTEX,
          buffer: { type: 'uniform', hasDynamicOffset: true }
        }
      ]
    });
    const secondLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: SHADER_STAGE_VERTEX, buffer: { type: 'uniform' } }]
    });
    const pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [firstLayout] })
    });
    const buffer = device.createBuffer({ size: 64, usage: BUFFER_USAGE_UNIFORM });
    const bindGroup = device.createBindGroup({
      layout: firstLayout,
      entries: [{ binding: 0, resource: { buffer, size: 32 } }]
    });
    const incompatible = device.createBindGroup({
      layout: secondLayout,
      entries: [{ binding: 0, resource: { buffer } }]
    });
    const { pass } = createPass(device);

    pass.setPipeline(pipeline);

    expect(() => pass.setBindGroup(0, bindGroup)).toThrow(
      'Bind group at slot 0 requires 1 dynamic offsets, received 0.'
    );
    expect(() => pass.setBindGroup(0, incompatible)).toThrow(
      'Bind group layout at slot 0 is not compatible with the current pipeline layout.'
    );
  });

  test('validates invalid resources and post-creation release at binding time', () => {
    const device = new NullDevice();
    const samplerLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: SHADER_STAGE_FRAGMENT, sampler: { type: 'filtering' } }]
    });

    expect(() =>
      device.createBindGroup({
        layout: samplerLayout,
        entries: [{ binding: 0, resource: null as never }]
      })
    ).toThrow('Binding 0 resource is missing or invalid.');

    const bufferLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: SHADER_STAGE_VERTEX, buffer: { type: 'uniform' } }]
    });

    expect(() =>
      device.createBindGroup({
        layout: bufferLayout,
        entries: [{ binding: 0, resource: { buffer: null } as never }]
      })
    ).toThrow('Binding 0 resource is missing or invalid.');

    const pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bufferLayout] })
    });
    const buffer = device.createBuffer({ label: 'late-release', size: 64, usage: BUFFER_USAGE_UNIFORM });
    const bindGroup = device.createBindGroup({
      layout: bufferLayout,
      entries: [{ binding: 0, resource: { buffer } }]
    });
    const { pass } = createPass(device);

    pass.setPipeline(pipeline);
    buffer.dispose();

    expect(() => pass.setBindGroup(0, bindGroup)).toThrow(
      'Resource "late-release" has been disposed.'
    );
  });

  test('rejects foreign and disposed bind groups and pipelines on pass encoders', () => {
    const firstDevice = new NullDevice();
    const secondDevice = new NullDevice();
    const layout = firstDevice.createBindGroupLayout({
      entries: [{ binding: 0, visibility: SHADER_STAGE_VERTEX, buffer: { type: 'uniform' } }]
    });
    const buffer = firstDevice.createBuffer({ size: 64, usage: BUFFER_USAGE_UNIFORM });
    const bindGroup = firstDevice.createBindGroup({
      label: 'foreign-bind-group',
      layout,
      entries: [{ binding: 0, resource: { buffer } }]
    });
    const pipeline = firstDevice.createRenderPipeline({ label: 'foreign-pipeline' });
    const { pass } = createPass(secondDevice);

    expect(() => pass.setBindGroup(0, bindGroup)).toThrow(
      'Resource "foreign-bind-group" belongs to a different NullDevice.'
    );
    expect(() => pass.setPipeline(pipeline)).toThrow(
      'Resource "foreign-pipeline" belongs to a different NullDevice.'
    );

    const localLayout = secondDevice.createBindGroupLayout({
      entries: [{ binding: 0, visibility: SHADER_STAGE_VERTEX, buffer: { type: 'uniform' } }]
    });
    const localBuffer = secondDevice.createBuffer({ size: 64, usage: BUFFER_USAGE_UNIFORM });
    const localBindGroup = secondDevice.createBindGroup({
      label: 'disposed-bind-group',
      layout: localLayout,
      entries: [{ binding: 0, resource: { buffer: localBuffer } }]
    });
    const localPipeline = secondDevice.createRenderPipeline({ label: 'disposed-pipeline' });

    localBindGroup.dispose();
    localPipeline.dispose();

    expect(() => pass.setBindGroup(0, localBindGroup)).toThrow(
      'Resource "disposed-bind-group" has been disposed.'
    );
    expect(() => pass.setPipeline(localPipeline)).toThrow(
      'Resource "disposed-pipeline" has been disposed.'
    );
  });

  test('rejects mapped buffers in bind groups and vertex buffers', async () => {
    const device = new NullDevice();
    const layout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: SHADER_STAGE_VERTEX, buffer: { type: 'uniform' } }]
    });
    const buffer = device.createBuffer({ label: 'mapped-binding', size: 64, usage: BUFFER_USAGE_UNIFORM });
    const { pass } = createPass(device);

    await buffer.mapAsync(0);

    expect(() =>
      device.createBindGroup({
        layout,
        entries: [{ binding: 0, resource: { buffer } }]
      })
    ).toThrow('Buffer "mapped-binding" is currently mapped.');
    expect(() => pass.setVertexBuffer(0, buffer)).toThrow('Buffer "mapped-binding" is currently mapped.');
  });

  test('catches compatibility changes after setBindGroup and dynamic offset range overflow', () => {
    const device = new NullDevice();
    const dynamicLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: SHADER_STAGE_VERTEX,
          buffer: { type: 'uniform', hasDynamicOffset: true }
        }
      ]
    });
    const incompatibleLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: SHADER_STAGE_VERTEX, buffer: { type: 'uniform' } }]
    });
    const buffer = device.createBuffer({ label: 'range-buffer', size: 64, usage: BUFFER_USAGE_UNIFORM });
    const bindGroup = device.createBindGroup({
      layout: dynamicLayout,
      entries: [{ binding: 0, resource: { buffer, size: 32 } }]
    });
    const { pass } = createPass(device);

    pass.setBindGroup(0, bindGroup, [16]);

    expect(() =>
      pass.setPipeline(
        device.createRenderPipeline({
          layout: device.createPipelineLayout({ bindGroupLayouts: [incompatibleLayout] })
        })
      )
    ).toThrow('Bind group layout at slot 0 is not compatible with the current pipeline layout.');

    expect(() => pass.setBindGroup(0, bindGroup, [40])).toThrow(
      'Buffer range 40..72 is outside buffer size 64.'
    );
  });

  test('orders dynamic offsets by binding number and checks min binding size', () => {
    const device = new NullDevice();
    const layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 4,
          visibility: SHADER_STAGE_VERTEX,
          buffer: { type: 'uniform', hasDynamicOffset: true }
        },
        {
          binding: 1,
          visibility: SHADER_STAGE_VERTEX,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 }
        }
      ]
    });
    const first = device.createBuffer({ label: 'first', size: 64, usage: BUFFER_USAGE_UNIFORM });
    const second = device.createBuffer({ label: 'second', size: 64, usage: BUFFER_USAGE_UNIFORM });

    expect(() =>
      device.createBindGroup({
        layout,
        entries: [
          { binding: 1, resource: { buffer: first, size: 8 } },
          { binding: 4, resource: { buffer: second, size: 16 } }
        ]
      })
    ).toThrow('Buffer binding size 8 is smaller than required minBindingSize 16.');

    const bindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 1, resource: { buffer: first, size: 16 } },
        { binding: 4, resource: { buffer: second, size: 16 } }
      ]
    });
    const { pass } = createPass(device);

    expect(() => pass.setBindGroup(0, bindGroup, [56, 0])).toThrow(
      'Buffer range 56..72 is outside buffer size 64.'
    );
    expect(() => pass.setBindGroup(0, bindGroup, [0, 56])).toThrow(
      'Buffer range 56..72 is outside buffer size 64.'
    );
  });

  test('requires live pipelines before draw and dispatch', () => {
    const device = new NullDevice();
    const { pass } = createPass(device);

    expect(() => pass.draw(3)).toThrow('requires a render pipeline before drawing.');

    const pipeline = device.createRenderPipeline({ label: 'disposed-pipeline' });
    pass.setPipeline(pipeline);
    pipeline.dispose();

    expect(() => pass.draw(3)).toThrow('Resource "disposed-pipeline" has been disposed.');

    const encoder = device.createCommandEncoder();
    const computePass = encoder.beginComputePass({ label: 'compute-pass' });

    expect(() => computePass.dispatchWorkgroups(1)).toThrow(
      'Compute pass "compute-pass" requires a compute pipeline before dispatch.'
    );
  });

  test('requires pipeline layout bind group slots before draw and revalidates bound buffers', async () => {
    const device = new NullDevice();
    const layout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: SHADER_STAGE_VERTEX, buffer: { type: 'uniform' } }]
    });
    const pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] })
    });
    const vertex = device.createBuffer({ label: 'live-vertex', size: 64, usage: BUFFER_USAGE_UNIFORM });
    const { pass } = createPass(device);

    pass.setPipeline(pipeline);

    expect(() => pass.draw(3)).toThrow(
      'Bind group slot 0 required by the current pipeline layout is not bound.'
    );

    const bindGroup = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: vertex } }]
    });

    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, vertex);
    await vertex.mapAsync(0);

    expect(() => pass.draw(3)).toThrow('Buffer "live-vertex" is currently mapped.');
  });

  test('records compute pass setBindGroup', () => {
    const device = new NullDevice();
    const layout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: SHADER_STAGE_VERTEX, buffer: { type: 'uniform' } }]
    });
    const pipeline = device.createComputePipeline({
      label: 'compute',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] })
    });
    const buffer = device.createBuffer({ size: 64, usage: BUFFER_USAGE_UNIFORM });
    const bindGroup = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer } }]
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass({ label: 'compute-pass' });

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.end();

    expect(encoder.finish().getCommandStream()).toContainEqual({
      kind: 'setBindGroup',
      scope: 'compute-pass',
      index: 0,
      bindGroup: { kind: 'bind-group', id: bindGroup.id },
      dynamicOffsets: []
    });
  });
});
