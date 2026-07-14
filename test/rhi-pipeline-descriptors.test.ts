import { describe, expect, test } from 'vitest';
import { NullDevice } from '../src';

const SHADER_STAGE_VERTEX = 1;

describe('RHI pipeline descriptors', () => {
  test('stores immutable expanded render pipeline descriptor snapshots', () => {
    const device = new NullDevice();
    const vertexModule = device.createShaderModule({ label: 'vertex-module', code: '@vertex fn main() {}' });
    const fragmentModule = device.createShaderModule({ label: 'fragment-module', code: '@fragment fn main() {}' });
    const constants = { exposure: 1 };
    const vertexBuffers = [
      {
        arrayStride: 24,
        stepMode: 'vertex' as const,
        attributes: [{ format: 'float32x3', offset: 0, shaderLocation: 0 }]
      }
    ];
    const targets = [
      {
        format: 'rgba8unorm',
        writeMask: 0xf,
        blend: {
          color: { operation: 'add' as const, srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
          alpha: { operation: 'add' as const, srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }
        }
      }
    ];
    const descriptor = {
      label: 'expanded-render-pipeline',
      vertex: {
        module: vertexModule,
        entryPoint: 'vsMain',
        constants,
        buffers: vertexBuffers
      },
      fragment: {
        module: fragmentModule,
        entryPoint: 'fsMain',
        targets
      },
      primitive: {
        topology: 'triangle-list' as const,
        frontFace: 'ccw' as const,
        cullMode: 'back' as const
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less' as const
      },
      multisample: {
        count: 4,
        mask: 0xffff_ffff,
        alphaToCoverageEnabled: true
      }
    };

    const pipeline = device.createRenderPipeline(descriptor);

    constants.exposure = 2;
    vertexBuffers[0]!.attributes.push({ format: 'float32x2', offset: 12, shaderLocation: 1 });
    targets[0]!.format = 'bgra8unorm';

    expect(pipeline.descriptor.vertex?.module).toBe(vertexModule);
    expect(pipeline.descriptor.vertex?.constants?.exposure).toBe(1);
    expect(pipeline.descriptor.vertex?.buffers?.[0]?.attributes).toEqual([
      { format: 'float32x3', offset: 0, shaderLocation: 0 }
    ]);
    expect(pipeline.descriptor.fragment?.module).toBe(fragmentModule);
    expect(pipeline.descriptor.fragment?.targets[0]?.format).toBe('rgba8unorm');
    expect(pipeline.descriptor.depthStencil?.depthCompare).toBe('less');
    expect(pipeline.descriptor.multisample?.count).toBe(4);
    expect(pipeline.topology).toBe('triangle-list');
  });

  test('stores immutable expanded compute pipeline descriptor snapshots', () => {
    const device = new NullDevice();
    const computeModule = device.createShaderModule({ label: 'compute-module', code: '@compute fn main() {}' });
    const constants = { workgroupSize: 64 };

    const pipeline = device.createComputePipeline({
      label: 'expanded-compute-pipeline',
      compute: {
        module: computeModule,
        entryPoint: 'csMain',
        constants
      }
    });

    constants.workgroupSize = 128;

    expect(pipeline.descriptor.compute?.module).toBe(computeModule);
    expect(pipeline.descriptor.compute?.entryPoint).toBe('csMain');
    expect(pipeline.descriptor.compute?.constants?.workgroupSize).toBe(64);
  });

  test('keeps minimal render and compute pipeline descriptors valid', () => {
    const device = new NullDevice();

    const renderPipeline = device.createRenderPipeline({
      label: 'minimal-render',
      primitive: { topology: 'line-list' }
    });
    const computePipeline = device.createComputePipeline({ label: 'minimal-compute' });

    expect(renderPipeline.topology).toBe('line-list');
    expect(renderPipeline.descriptor.vertex).toBeUndefined();
    expect(computePipeline.descriptor.compute).toBeUndefined();
  });

  test('rejects foreign and disposed shader modules in pipeline stages', () => {
    const firstDevice = new NullDevice();
    const secondDevice = new NullDevice();
    const foreignModule = firstDevice.createShaderModule({ label: 'foreign-module', code: '@vertex fn main() {}' });
    const localModule = secondDevice.createShaderModule({ label: 'disposed-module', code: '@vertex fn main() {}' });

    expect(() =>
      secondDevice.createRenderPipeline({
        vertex: { module: foreignModule }
      })
    ).toThrow('Resource "foreign-module" belongs to a different NullDevice.');

    localModule.dispose();

    expect(() =>
      secondDevice.createComputePipeline({
        compute: { module: localModule }
      })
    ).toThrow('Resource "disposed-module" has been disposed.');
  });

  test('rejects incomplete stage descriptors from untyped callers', () => {
    const device = new NullDevice();
    const fragmentModule = device.createShaderModule({ label: 'fragment-only', code: '@fragment fn main() {}' });

    expect(() =>
      device.createRenderPipeline({
        fragment: { module: fragmentModule, targets: [{ format: 'rgba8unorm' }] }
      })
    ).toThrow('Vertex stage must be provided if fragment stage is present.');

    expect(() =>
      device.createRenderPipeline({
        vertex: {} as never
      })
    ).toThrow('Vertex stage module is required.');

    expect(() =>
      device.createRenderPipeline({
        vertex: { module: device.createShaderModule({ code: '@vertex fn main() {}' }) },
        fragment: { targets: [{ format: 'rgba8unorm' }] } as never
      })
    ).toThrow('Fragment stage module is required.');

    expect(() =>
      device.createComputePipeline({
        compute: {} as never
      })
    ).toThrow('Compute stage module is required.');
  });

  test('rejects invalid pipeline descriptor values from untyped callers', () => {
    const device = new NullDevice();
    const vertexModule = device.createShaderModule({ label: 'validation-vertex', code: '@vertex fn main() {}' });
    const fragmentModule = device.createShaderModule({ label: 'validation-fragment', code: '@fragment fn main() {}' });
    const computeModule = device.createShaderModule({ label: 'validation-compute', code: '@compute fn main() {}' });

    const invalidDescriptors: Array<{ create: () => void; message: string }> = [
      {
        create: () => {
          device.createRenderPipeline(null as never);
        },
        message: 'Render pipeline descriptor must be an object.'
      },
      {
        create: () => {
          device.createComputePipeline(null as never);
        },
        message: 'Compute pipeline descriptor must be an object.'
      },
      {
        create: () => {
          device.createRenderPipeline({ vertex: { module: vertexModule, entryPoint: '' } });
        },
        message: 'Vertex stage entryPoint must be a non-empty string.'
      },
      {
        create: () => {
          device.createComputePipeline({ compute: { module: computeModule, constants: { bad: Number.NaN } } });
        },
        message: 'Compute stage constant "bad" must be a finite number.'
      },
      {
        create: () => {
          device.createComputePipeline({ compute: { module: computeModule, entryPoint: '' } });
        },
        message: 'Compute stage entryPoint must be a non-empty string.'
      },
      {
        create: () => {
          device.createRenderPipeline({ vertex: { module: vertexModule, constants: { bad: Number.POSITIVE_INFINITY } } });
        },
        message: 'Vertex stage constant "bad" must be a finite number.'
      },
      {
        create: () => {
          device.createRenderPipeline({
            vertex: { module: vertexModule, buffers: [{ arrayStride: -1, attributes: [] }] }
          });
        },
        message: 'Vertex buffer 0 arrayStride must be a non-negative integer.'
      },
      {
        create: () => {
          device.createRenderPipeline({
            vertex: { module: vertexModule, buffers: [{ arrayStride: 4, attributes: {} as never }] }
          });
        },
        message: 'Vertex buffer 0 attributes must be an array.'
      },
      {
        create: () => {
          device.createRenderPipeline({
            vertex: {
              module: vertexModule,
              buffers: [{ arrayStride: 4, attributes: [{ format: '', offset: 0, shaderLocation: 0 }] }]
            }
          });
        },
        message: 'Vertex buffer 0 attribute 0 format must be a non-empty string.'
      },
      {
        create: () => {
          device.createRenderPipeline({
            vertex: {
              module: vertexModule,
              buffers: [{ arrayStride: 4, attributes: [{ format: 'float32', offset: -1, shaderLocation: 0 }] }]
            }
          });
        },
        message: 'Vertex buffer 0 attribute 0 offset must be a non-negative integer.'
      },
      {
        create: () => {
          device.createRenderPipeline({
            vertex: {
              module: vertexModule,
              buffers: [{ arrayStride: 4, attributes: [{ format: 'float32', offset: 0, shaderLocation: 1.5 }] }]
            }
          });
        },
        message: 'Vertex buffer 0 attribute 0 shaderLocation must be a non-negative integer.'
      },
      {
        create: () => {
          device.createRenderPipeline({
            vertex: { module: vertexModule },
            fragment: { module: fragmentModule, targets: {} as never }
          });
        },
        message: 'Fragment targets must be an array.'
      },
      {
        create: () => {
          device.createRenderPipeline({
            vertex: { module: vertexModule },
            fragment: { module: fragmentModule, constants: { bad: Number.NEGATIVE_INFINITY }, targets: [{ format: '' }] }
          });
        },
        message: 'Fragment stage constant "bad" must be a finite number.'
      },
      {
        create: () => {
          device.createRenderPipeline({
            vertex: { module: vertexModule },
            fragment: { module: fragmentModule, targets: [{ format: '' }] }
          });
        },
        message: 'Fragment target 0 format must be a non-empty string.'
      },
      {
        create: () => {
          device.createRenderPipeline({
            vertex: { module: vertexModule },
            fragment: { module: fragmentModule, targets: [{ format: 'rgba8unorm', writeMask: -1 }] }
          });
        },
        message: 'Fragment target 0 writeMask must be a non-negative integer.'
      },
      {
        create: () => {
          device.createRenderPipeline({
            vertex: { module: vertexModule },
            fragment: {
              module: fragmentModule,
              targets: [
                {
                  format: 'rgba8unorm',
                  blend: {
                    color: { srcFactor: '', dstFactor: 'one' },
                    alpha: { srcFactor: 'one', dstFactor: 'zero' }
                  }
                }
              ]
            }
          });
        },
        message: 'Fragment target 0 blend color srcFactor must be a non-empty string.'
      },
      {
        create: () => {
          device.createRenderPipeline({
            vertex: { module: vertexModule },
            fragment: {
              module: fragmentModule,
              targets: [
                {
                  format: 'rgba8unorm',
                  blend: {
                    color: { srcFactor: 'one', dstFactor: 'zero' },
                    alpha: { srcFactor: 'one', dstFactor: '' }
                  }
                }
              ]
            }
          });
        },
        message: 'Fragment target 0 blend alpha dstFactor must be a non-empty string.'
      },
      {
        create: () => {
          device.createRenderPipeline({ depthStencil: { format: '' } });
        },
        message: 'Depth-stencil format must be a non-empty string.'
      },
      {
        create: () => {
          device.createRenderPipeline({ multisample: { count: 0 } });
        },
        message: 'Multisample count must be a positive integer.'
      },
      {
        create: () => {
          device.createRenderPipeline({ multisample: { mask: -1 } });
        },
        message: 'Multisample mask must be a non-negative integer.'
      }
    ];

    for (const { create, message } of invalidDescriptors) {
      expect(create).toThrow(message);
    }
  });

  test('preserves null entries in vertex buffers and fragment targets', () => {
    const device = new NullDevice();
    const vertexModule = device.createShaderModule({ label: 'nullable-vertex', code: '@vertex fn main() {}' });
    const fragmentModule = device.createShaderModule({ label: 'nullable-fragment', code: '@fragment fn main() {}' });

    const pipeline = device.createRenderPipeline({
      vertex: {
        module: vertexModule,
        buffers: [
          null,
          {
            arrayStride: 16,
            attributes: [{ format: 'float32x4', offset: 0, shaderLocation: 0 }]
          }
        ]
      },
      fragment: {
        module: fragmentModule,
        targets: [null, { format: 'rgba8unorm' }]
      }
    });

    expect(pipeline.descriptor.vertex?.buffers?.[0]).toBeNull();
    expect(pipeline.descriptor.vertex?.buffers?.[1]).toEqual({
      arrayStride: 16,
      attributes: [{ format: 'float32x4', offset: 0, shaderLocation: 0 }]
    });
    expect(pipeline.descriptor.fragment?.targets[0]).toBeNull();
    expect(pipeline.descriptor.fragment?.targets[1]).toEqual({ format: 'rgba8unorm' });
  });
});
