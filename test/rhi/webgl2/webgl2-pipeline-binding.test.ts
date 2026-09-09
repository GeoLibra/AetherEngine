import { describe, expect, test } from 'vitest';

import {
  WebGL2Adapter,
  type WebGL2NativeContextLostInfo,
  type WebGL2BindingManifestEntry,
  type WebGL2NativeContextPort,
  type WebGL2ShaderTranslationPort,
  type WebGL2TranslatedShader
} from '../../../src';

interface NativeObject {
  readonly id: number;
  readonly kind: string;
}
type TranslationInput = Parameters<WebGL2ShaderTranslationPort['translate']>[0];
type TranslationCall = Pick<TranslationInput, 'stage' | 'entryPoint' | 'constants' | 'clipDepthMode'>;

class Translator implements WebGL2ShaderTranslationPort {
  readonly translatorId = 'test';
  readonly version = 1;
  readonly calls: TranslationCall[] = [];
  textureSlot = 0;
  translate(input: TranslationInput): WebGL2TranslatedShader {
    this.calls.push({
      stage: input.stage,
      entryPoint: input.entryPoint,
      constants: { ...input.constants },
      clipDepthMode: input.clipDepthMode
    });
    return {
      source: `void ${input.entryPoint}() {}`,
      bindings: [
        { group: 0, binding: 0, name: 'Camera', kind: 'uniform-buffer' },
        { group: 0, binding: 1, name: 'colorTexture', kind: 'texture' },
        { group: 0, binding: 2, name: 'colorSampler', kind: 'sampler' }
      ],
      targetAbiFingerprint: 'test-abi',
      physicalBindings: [
        { group: 0, binding: 0, kind: 'uniform-buffer', slot: 0 },
        { group: 0, binding: 1, kind: 'texture', slot: this.textureSlot },
        { group: 0, binding: 2, kind: 'sampler', slot: this.textureSlot }
      ],
      programBindings: [
        { kind: 'uniform-buffer', name: 'Camera', slot: 0 },
        { kind: 'combined-sampler', name: 'aether_t0_1_s0_2', slot: this.textureSlot }
      ],
      requiredExtensions: [],
      sourceMap: [],
      translatorFingerprint: 'test-output'
    };
  }
}

class PipelineContext implements WebGL2NativeContextPort {
  readonly info = { name: 'Pipeline WebGL2' };
  readonly extensions = new Set<string>();
  readonly limits = {
    maxUniformBufferBindings: 2,
    maxTextureUnits: 4,
    uniformBufferOffsetAlignment: 256
  };
  readonly formats = new Map();
  readonly precision = {};
  readonly lost = new Promise<WebGL2NativeContextLostInfo>(() => {});
  readonly programs: Readonly<Record<string, unknown>>[] = [];
  reflection: readonly WebGL2BindingManifestEntry[] | undefined;
  programError: Error | undefined;
  private nextId = 1;
  createBuffer(): NativeObject {
    return this.object('buffer');
  }
  createTexture(): NativeObject {
    return this.object('texture');
  }
  createSampler(): NativeObject {
    return this.object('sampler');
  }
  createProgram(descriptor: Readonly<Record<string, unknown>>): NativeObject {
    if (this.programError !== undefined) throw this.programError;
    this.programs.push(descriptor);
    return this.object('program');
  }
  getProgramReflection(): readonly WebGL2BindingManifestEntry[] {
    return this.reflection ?? [];
  }
  deleteBuffer(): void {}
  deleteTexture(): void {}
  deleteSampler(): void {}
  deleteProgram(): void {}
  private object(kind: string): NativeObject {
    return { id: this.nextId++, kind };
  }
}

async function createDevice() {
  const native = new PipelineContext();
  const translator = new Translator();
  const device = await new WebGL2Adapter(native, translator).requestDevice({
    requiredFeatures: [],
    optionalFeatures: []
  });
  return { device, native, translator };
}

function createPipelineInputs(device: Awaited<ReturnType<typeof createDevice>>['device']) {
  const buffer = device.createBuffer({ size: 1024, usage: 64 });
  const texture = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 4 });
  const sampler = device.createSampler();
  const module = device.createShaderModule({ label: 'main-shader', code: 'typed-ir-payload' });
  const groupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: 3,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 256 }
      },
      { binding: 1, visibility: 2, texture: { sampleType: 'float' } },
      { binding: 2, visibility: 2, sampler: { type: 'filtering' } }
    ]
  });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [groupLayout] });
  const group = device.createBindGroup({
    layout: groupLayout,
    entries: [
      { binding: 0, resource: { buffer, offset: 256, size: 256 } },
      { binding: 1, resource: texture.createView() },
      { binding: 2, resource: sampler }
    ]
  });
  return { module, layout, group };
}

describe('WebGL2 shader, binding, and pipeline lowering', () => {
  test('translates stages and creates a reflected program with immutable manifests', async () => {
    const { device, native, translator } = await createDevice();
    const { module, layout, group } = createPipelineInputs(device);
    native.reflection = [
      { group: 0, binding: 0, name: 'Camera', kind: 'uniform-buffer' },
      { group: 0, binding: 1, name: 'colorTexture', kind: 'texture' },
      { group: 0, binding: 2, name: 'colorSampler', kind: 'sampler' }
    ];
    const constants = { QUALITY: 2 };

    const pipeline = device.createRenderPipeline({
      label: 'basic',
      layout,
      vertex: { module, entryPoint: 'vsMain', constants },
      fragment: { module, entryPoint: 'fsMain', targets: [{ format: 'rgba8unorm' }] }
    });
    constants.QUALITY = 9;

    expect(translator.calls).toEqual([
      {
        stage: 'vertex',
        entryPoint: 'vsMain',
        constants: { QUALITY: 2 },
        clipDepthMode: 'vertex-remap'
      },
      {
        stage: 'fragment',
        entryPoint: 'fsMain',
        constants: {},
        clipDepthMode: 'vertex-remap'
      }
    ]);
    expect(native.programs).toHaveLength(1);
    expect(native.programs[0]?.vertexSource).toMatch(/^#version 300 es/);
    expect(native.programs[0]?.bindings).toHaveLength(3);
    expect(native.programs[0]?.programBindings).toEqual([
      { kind: 'combined-sampler', name: 'aether_t0_1_s0_2', slot: 0 },
      { kind: 'uniform-buffer', name: 'Camera', slot: 0 }
    ]);
    expect(pipeline.layout).toBe(layout);
    expect(pipeline.descriptor.vertex?.constants).toEqual({ QUALITY: 2 });
    expect(group.dynamicBindingCount).toBe(1);
  });

  test('rejects misaligned UBO offsets before creating a bind group', async () => {
    const { device } = await createDevice();
    const buffer = device.createBuffer({ size: 1024, usage: 64 });
    const layout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: 1, buffer: { type: 'uniform' } }]
    });

    expect(() =>
      device.createBindGroup({
        layout,
        entries: [{ binding: 0, resource: { buffer, offset: 4, size: 256 } }]
      })
    ).toThrow('Uniform buffer binding 0 offset 4 is not aligned to 256.');
  });

  test('rejects program reflection that differs from the translated manifest', async () => {
    const { device, native } = await createDevice();
    const { module, layout } = createPipelineInputs(device);
    native.reflection = [{ group: 0, binding: 7, name: 'wrong', kind: 'texture' }];

    expect(() =>
      device.createRenderPipeline({
        label: 'mismatch',
        layout,
        vertex: { module, entryPoint: 'vsMain' },
        fragment: { module, entryPoint: 'fsMain', targets: [{ format: 'rgba8unorm' }] }
      })
    ).toThrow('WebGL2 program "mismatch" reflection does not match its binding manifest.');
  });

  test('rejects binding layouts over probed limits before program creation', async () => {
    const { device, native } = await createDevice();
    native.limits.maxTextureUnits = 0;

    expect(() =>
      device.createBindGroupLayout({
        entries: [{ binding: 0, visibility: 2, texture: { sampleType: 'float' } }]
      })
    ).toThrow('WebGL2 bind group layout requires 1 textures, limit is 0.');
    expect(native.programs).toHaveLength(0);
  });

  test('rejects cumulative pipeline layout bindings over device limits', async () => {
    const { device, native } = await createDevice();
    native.limits.maxTextureUnits = 1;
    const first = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: 2, texture: { sampleType: 'float' } }]
    });
    const second = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: 2, texture: { sampleType: 'float' } }]
    });

    expect(() => device.createPipelineLayout({ bindGroupLayouts: [first, second] })).toThrow(
      'WebGL2 pipeline layout requires 2 textures, limit is 1.'
    );
  });

  test('rejects translated physical slots outside probed limits', async () => {
    const { device, native, translator } = await createDevice();
    native.limits.maxTextureUnits = 1;
    translator.textureSlot = 1;
    const { module, layout } = createPipelineInputs(device);

    expect(() =>
      device.createRenderPipeline({
        layout,
        vertex: { module, entryPoint: 'vsMain' },
        fragment: { module, entryPoint: 'fsMain', targets: [{ format: 'rgba8unorm' }] }
      })
    ).toThrow('WebGL2 physical texture slot 1 exceeds limit 1.');
    expect(native.programs).toHaveLength(0);
  });

  test('preserves pipeline label and native cause on program creation failure', async () => {
    const { device, native } = await createDevice();
    const { module, layout } = createPipelineInputs(device);
    const cause = new Error('GLSL link log');
    native.programError = cause;

    expect(() =>
      device.createRenderPipeline({
        label: 'broken',
        layout,
        vertex: { module, entryPoint: 'vsMain' },
        fragment: { module, entryPoint: 'fsMain', targets: [{ format: 'rgba8unorm' }] }
      })
    ).toThrow(
      expect.objectContaining({
        name: 'WebGL2ProgramCreationError',
        pipelineLabel: 'broken',
        cause
      })
    );
  });
});
