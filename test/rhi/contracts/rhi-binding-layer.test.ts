import { describe, expect, test } from 'vitest';
import { NullDevice } from '../../../src';

const BUFFER_USAGE_UNIFORM = 8;
const SHADER_STAGE_VERTEX = 1;
const SHADER_STAGE_FRAGMENT = 2;

describe('RHI binding layer resources', () => {
  test('records immutable shader, layout, pipeline layout, and bind group descriptors', () => {
    const device = new NullDevice();
    const shaderDescriptor = { label: 'shader', code: '@vertex fn main() {}' };
    const shader = device.createShaderModule(shaderDescriptor);
    const layoutEntries = [
      {
        binding: 0,
        visibility: SHADER_STAGE_VERTEX,
        buffer: { type: 'uniform' as const, hasDynamicOffset: true }
      }
    ];
    const layoutDescriptor = { label: 'frame-layout', entries: layoutEntries };
    const bindGroupLayout = device.createBindGroupLayout(layoutDescriptor);
    const pipelineLayoutDescriptor = {
      label: 'pipeline-layout',
      bindGroupLayouts: [bindGroupLayout]
    };
    const pipelineLayout = device.createPipelineLayout(pipelineLayoutDescriptor);
    const buffer = device.createBuffer({
      label: 'ubo',
      size: 64,
      usage: BUFFER_USAGE_UNIFORM
    });
    const bindGroupDescriptor = {
      label: 'frame-bind-group',
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer, offset: 16, size: 32 } }]
    };
    const bindGroup = device.createBindGroup(bindGroupDescriptor);

    shaderDescriptor.code = 'mutated';
    layoutEntries.push({
      binding: 1,
      visibility: SHADER_STAGE_FRAGMENT,
      buffer: { type: 'uniform', hasDynamicOffset: false }
    });
    pipelineLayoutDescriptor.bindGroupLayouts.length = 0;
    bindGroupDescriptor.entries.length = 0;

    expect(shader.descriptor.code).toBe('@vertex fn main() {}');
    expect(bindGroupLayout.descriptor.entries).toHaveLength(1);
    expect(pipelineLayout.descriptor.bindGroupLayouts).toEqual([bindGroupLayout]);
    expect(bindGroup.descriptor.entries).toHaveLength(1);
  });

  test('rejects duplicate layout bindings and invalid bind group entries', () => {
    const device = new NullDevice();

    expect(() =>
      device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: SHADER_STAGE_VERTEX, buffer: { type: 'uniform' } },
          { binding: 0, visibility: SHADER_STAGE_FRAGMENT, sampler: { type: 'filtering' } }
        ]
      })
    ).toThrow('Bind group layout contains duplicate binding 0.');

    const layout = device.createBindGroupLayout({
      label: 'layout',
      entries: [
        { binding: 0, visibility: SHADER_STAGE_VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: SHADER_STAGE_FRAGMENT, sampler: { type: 'filtering' } }
      ]
    });
    const buffer = device.createBuffer({ label: 'ubo', size: 64, usage: BUFFER_USAGE_UNIFORM });

    expect(() =>
      device.createBindGroup({
        layout,
        entries: [{ binding: 0, resource: { buffer } }]
      })
    ).toThrow('Bind group is missing resource for binding 1.');

    expect(() =>
      device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer } },
          { binding: 1, resource: { buffer } }
        ]
      })
    ).toThrow('Binding 1 expects a sampler resource.');
  });

  test('validates ownership and release state for layouts and resources', () => {
    const firstDevice = new NullDevice();
    const secondDevice = new NullDevice();
    const foreignLayout = firstDevice.createBindGroupLayout({
      label: 'foreign-layout',
      entries: [{ binding: 0, visibility: SHADER_STAGE_VERTEX, buffer: { type: 'uniform' } }]
    });
    const localLayout = secondDevice.createBindGroupLayout({
      entries: [{ binding: 0, visibility: SHADER_STAGE_VERTEX, buffer: { type: 'uniform' } }]
    });
    const foreignBuffer = firstDevice.createBuffer({
      label: 'foreign-buffer',
      size: 64,
      usage: BUFFER_USAGE_UNIFORM
    });

    expect(() => secondDevice.createPipelineLayout({ bindGroupLayouts: [foreignLayout] })).toThrow(
      'Resource "foreign-layout" belongs to a different NullDevice.'
    );

    expect(() =>
      secondDevice.createBindGroup({
        layout: localLayout,
        entries: [{ binding: 0, resource: { buffer: foreignBuffer } }]
      })
    ).toThrow('Resource "foreign-buffer" belongs to a different NullDevice.');

    localLayout.dispose();

    expect(() =>
      secondDevice.createBindGroup({
        layout: localLayout,
        entries: [{ binding: 0, resource: { buffer: foreignBuffer } }]
      })
    ).toThrow('Resource "bind-group-layout" has been disposed.');
  });
});
