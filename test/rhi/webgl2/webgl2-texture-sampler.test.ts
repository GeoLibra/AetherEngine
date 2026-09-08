import { describe, expect, it } from 'vitest';
import { createBrowserWebGL2OperationPort } from '../../../src/rhi/webgl2/browser/operations';
import {
  COLOR_BUFFER_FLOAT_EXTENSION,
  TEXTURE_FLOAT_LINEAR_EXTENSION,
  queryWebGL2Formats
} from '../../../src/rhi/webgl2/browser/capability-query';
import { createCookedArtifactWebGL2Translator } from '../../../src/rhi/webgl2/shader/cooked-artifact-translator';
import type { CookedShaderRuntimeArtifact } from '../../../src/shader/types';

class MockWebGL2GL {
  readonly TEXTURE_2D = 0x0de1;
  readonly PIXEL_UNPACK_BUFFER = 0x88ec;
  readonly PIXEL_PACK_BUFFER = 0x88eb;
  readonly UNPACK_ROW_LENGTH = 0x0cf2;
  readonly UNPACK_ALIGNMENT = 0x0cf5;
  readonly PACK_ROW_LENGTH = 0x0d02;
  readonly PACK_ALIGNMENT = 0x0d05;
  readonly RGBA = 0x1908;
  readonly RGBA16F = 0x881a;
  readonly RGBA8 = 0x8058;
  readonly HALF_FLOAT = 0x140b;
  readonly UNSIGNED_BYTE = 0x1401;
  readonly FRAMEBUFFER = 0x8d40;
  readonly COLOR_ATTACHMENT0 = 0x8ce0;
  readonly TEXTURE_MIN_FILTER = 0x2801;
  readonly TEXTURE_MAG_FILTER = 0x2800;
  readonly TEXTURE_WRAP_S = 0x2802;
  readonly TEXTURE_WRAP_T = 0x2803;
  readonly TEXTURE_WRAP_R = 0x8072;
  readonly NEAREST = 0x2600;
  readonly LINEAR = 0x2601;
  readonly NEAREST_MIPMAP_NEAREST = 0x2700;
  readonly LINEAR_MIPMAP_NEAREST = 0x2701;
  readonly NEAREST_MIPMAP_LINEAR = 0x2702;
  readonly LINEAR_MIPMAP_LINEAR = 0x2703;
  readonly REPEAT = 0x2901;
  readonly CLAMP_TO_EDGE = 0x812f;
  readonly MIRRORED_REPEAT = 0x8370;
  readonly MAX_SAMPLES = 0x8d57;
  readonly IMPLEMENTATION_COLOR_READ_FORMAT = 0x8b9b;
  readonly IMPLEMENTATION_COLOR_READ_TYPE = 0x8b9a;
  readType = this.HALF_FLOAT;

  public readonly calls: [string, ...unknown[]][] = [];
  private nextId = 1;

  createTexture(): object {
    return { kind: 'texture', id: this.nextId++ };
  }
  bindTexture(...args: unknown[]): void {
    this.calls.push(['bindTexture', ...args]);
  }
  texStorage2D(...args: unknown[]): void {
    this.calls.push(['texStorage2D', ...args]);
  }
  texParameteri(...args: unknown[]): void {
    this.calls.push(['texParameteri', ...args]);
  }
  texSubImage2D(...args: unknown[]): void {
    this.calls.push(['texSubImage2D', ...args]);
  }
  deleteTexture(...args: unknown[]): void {
    this.calls.push(['deleteTexture', ...args]);
  }
  createFramebuffer(): object {
    return { kind: 'framebuffer', id: this.nextId++ };
  }
  bindFramebuffer(...args: unknown[]): void {
    this.calls.push(['bindFramebuffer', ...args]);
  }
  framebufferTexture2D(...args: unknown[]): void {
    this.calls.push(['framebufferTexture2D', ...args]);
  }
  deleteFramebuffer(...args: unknown[]): void {
    this.calls.push(['deleteFramebuffer', ...args]);
  }
  readPixels(...args: unknown[]): void {
    this.calls.push(['readPixels', ...args]);
  }
  bindBuffer(...args: unknown[]): void {
    this.calls.push(['bindBuffer', ...args]);
  }
  pixelStorei(...args: unknown[]): void {
    this.calls.push(['pixelStorei', ...args]);
  }
  createSampler(): object {
    return { kind: 'sampler', id: this.nextId++ };
  }
  samplerParameteri(...args: unknown[]): void {
    this.calls.push(['samplerParameteri', ...args]);
  }
  deleteSampler(...args: unknown[]): void {
    this.calls.push(['deleteSampler', ...args]);
  }
  getParameter(pname: number): unknown {
    if (pname === this.IMPLEMENTATION_COLOR_READ_FORMAT) return this.RGBA;
    if (pname === this.IMPLEMENTATION_COLOR_READ_TYPE) return this.readType;
    if (pname === this.MAX_SAMPLES) return 4;
    return 0;
  }
}

describe('WebGL2 texture copy port contract', () => {
  it('rejects FLOAT-only readback before issuing an incompatible half-float buffer copy', () => {
    const gl = new MockWebGL2GL();
    gl.readType = 0x1406;
    const port = createBrowserWebGL2OperationPort(gl);
    const texture = port.createTexture!({ size: { width: 1, height: 1 }, format: 'rgba16float' });
    expect(() =>
      port.copyTextureToBuffer!(
        { texture },
        { buffer: {}, bytesPerRow: 8 },
        { width: 1, height: 1 }
      )
    ).toThrow(/HALF_FLOAT/);
    expect(gl.calls.some(([name]) => name === 'readPixels')).toBe(false);
    expect(gl.calls.some(([name]) => name === 'deleteFramebuffer')).toBe(true);
  });
  it('handles RGBA16F writeTexture upload with correct type, mip, row pitch, and offset', () => {
    const gl = new MockWebGL2GL();
    const port = createBrowserWebGL2OperationPort(gl);

    const texture = port.createTexture?.({
      size: { width: 16, height: 16, depthOrArrayLayers: 1 },
      format: 'rgba16float',
      usage: 0x10,
      mipLevelCount: 2,
      sampleCount: 1
    });
    expect(texture).toBeDefined();

    // 8 bytes per pixel for rgba16float (4 channels * 2 bytes)
    // 8 pixels per row * 8 = 64 bytesPerRow
    const uploadBytes = new Uint8Array(256);
    // Fill with pattern
    const uploadU16 = new Uint16Array(uploadBytes.buffer);
    for (let i = 0; i < uploadU16.length; i++) uploadU16[i] = 15360; // FP16 1.0

    gl.calls.length = 0;
    port.writeTexture?.(
      { texture: texture!, mipLevel: 1, origin: { x: 2, y: 3 } },
      uploadBytes,
      { offset: 16, bytesPerRow: 64 },
      { width: 4, height: 4, depthOrArrayLayers: 1 }
    );

    // Verify row pitch setup
    expect(gl.calls).toEqual(
      expect.arrayContaining([
        ['pixelStorei', gl.UNPACK_ALIGNMENT, 4],
        ['pixelStorei', gl.UNPACK_ROW_LENGTH, 8], // 64 bytes / 8 bytes per pixel = 8 pixels
        ['bindTexture', gl.TEXTURE_2D, texture],
        [
          'texSubImage2D',
          gl.TEXTURE_2D,
          1, // mipLevel
          2, // x
          3, // y
          4, // width
          4, // height
          gl.RGBA,
          gl.HALF_FLOAT,
          expect.any(Uint16Array)
        ],
        ['pixelStorei', gl.UNPACK_ROW_LENGTH, 0] // resets row length
      ])
    );

    // Verify upload slice passed has byteOffset shifted by 16 bytes (offset / 2 = 8 u16 elements)
    const texSubCall = gl.calls.find(([name]) => name === 'texSubImage2D');
    const u16Passed = texSubCall![9] as Uint16Array;
    expect(u16Passed.byteOffset).toBe(16);
  });

  it('handles RGBA16F copyTextureToBuffer readback with correct type, mip, row pitch, and offset', () => {
    const gl = new MockWebGL2GL();
    const port = createBrowserWebGL2OperationPort(gl);

    const texture = port.createTexture?.({
      size: { width: 16, height: 16, depthOrArrayLayers: 1 },
      format: 'rgba16float',
      usage: 0x10,
      mipLevelCount: 2,
      sampleCount: 1
    });
    const buffer = { kind: 'buffer', id: 99 };

    gl.calls.length = 0;
    port.copyTextureToBuffer?.(
      { texture: texture!, mipLevel: 1, origin: { x: 1, y: 2 } },
      { buffer, offset: 32, bytesPerRow: 128 },
      { width: 8, height: 8, depthOrArrayLayers: 1 }
    );

    expect(gl.calls).toEqual(
      expect.arrayContaining([
        ['bindFramebuffer', gl.FRAMEBUFFER, expect.any(Object)],
        ['framebufferTexture2D', gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 1],
        ['bindBuffer', gl.PIXEL_PACK_BUFFER, buffer],
        ['pixelStorei', gl.PACK_ALIGNMENT, 4],
        ['pixelStorei', gl.PACK_ROW_LENGTH, 16], // 128 / 8 = 16 pixels
        [
          'readPixels',
          1, // x
          2, // y
          8, // width
          8, // height
          gl.RGBA,
          gl.HALF_FLOAT,
          32 // offset
        ],
        ['pixelStorei', gl.PACK_ROW_LENGTH, 0],
        ['bindBuffer', gl.PIXEL_PACK_BUFFER, null],
        ['deleteFramebuffer', expect.any(Object)]
      ])
    );
  });
});

describe('WebGL2 format capability queries', () => {
  it('omits rgba16float format when EXT_color_buffer_float is absent', () => {
    const gl = new MockWebGL2GL() as any;
    const extensions = new Set<string>();
    const formats = queryWebGL2Formats(gl, extensions);
    expect(formats.has('rgba16float')).toBe(false);
  });

  it('keeps core half-float filtering without the 32-bit float filtering extension', () => {
    const gl = new MockWebGL2GL() as any;
    const extensions = new Set<string>([COLOR_BUFFER_FLOAT_EXTENSION]);
    const formats = queryWebGL2Formats(gl, extensions);
    expect(formats.has('rgba16float')).toBe(true);
    const cap = formats.get('rgba16float')!;
    expect(cap.filter).toBe(true);
    expect(cap.sample).toBe(true);
    expect(cap.render).toBe(true);
    expect(cap.sampleCounts).toEqual([1, 4]);
  });

  it('declares rgba16float filter=true when both float color and linear filtering extensions are present', () => {
    const gl = new MockWebGL2GL() as any;
    const extensions = new Set<string>([
      COLOR_BUFFER_FLOAT_EXTENSION,
      TEXTURE_FLOAT_LINEAR_EXTENSION
    ]);
    const formats = queryWebGL2Formats(gl, extensions);
    expect(formats.has('rgba16float')).toBe(true);
    const cap = formats.get('rgba16float')!;
    expect(cap.filter).toBe(true);
    expect(cap.sample).toBe(true);
    expect(cap.render).toBe(true);
  });
});

describe('WebGL2 sampler min/mipmap combinations and U/V/W wrap modes', () => {
  it('configures all 4 minFilter and mipmapFilter combinations correctly', () => {
    const gl = new MockWebGL2GL();
    const port = createBrowserWebGL2OperationPort(gl);

    const testCases: [
      min: 'nearest' | 'linear',
      mip: 'nearest' | 'linear',
      expectedGlParam: number
    ][] = [
      ['nearest', 'nearest', gl.NEAREST_MIPMAP_NEAREST],
      ['nearest', 'linear', gl.NEAREST_MIPMAP_LINEAR],
      ['linear', 'nearest', gl.LINEAR_MIPMAP_NEAREST],
      ['linear', 'linear', gl.LINEAR_MIPMAP_LINEAR]
    ];

    for (const [minFilter, mipmapFilter, expected] of testCases) {
      gl.calls.length = 0;
      const sampler = port.createSampler?.({ minFilter, mipmapFilter, magFilter: 'linear' });
      expect(gl.calls).toContainEqual([
        'samplerParameteri',
        sampler,
        gl.TEXTURE_MIN_FILTER,
        expected
      ]);
    }
  });

  it('configures U/V/W wrap modes repeat, mirror-repeat, and clamp-to-edge', () => {
    const gl = new MockWebGL2GL();
    const port = createBrowserWebGL2OperationPort(gl);

    gl.calls.length = 0;
    const sampler1 = port.createSampler?.({
      addressModeU: 'repeat',
      addressModeV: 'mirror-repeat',
      addressModeW: 'clamp-to-edge'
    });
    expect(gl.calls).toContainEqual(['samplerParameteri', sampler1, gl.TEXTURE_WRAP_S, gl.REPEAT]);
    expect(gl.calls).toContainEqual([
      'samplerParameteri',
      sampler1,
      gl.TEXTURE_WRAP_T,
      gl.MIRRORED_REPEAT
    ]);
    expect(gl.calls).toContainEqual([
      'samplerParameteri',
      sampler1,
      gl.TEXTURE_WRAP_R,
      gl.CLAMP_TO_EDGE
    ]);
  });
});

describe('WebGL2 cooked artifact translator combined-sampler lowering', () => {
  it('lowers separate sampler to match texture binding slot in combined-sampler layout', () => {
    const mockArtifact: CookedShaderRuntimeArtifact = {
      schemaVersion: 2,
      shaderManifestSchemaVersion: 1,
      shaderModuleSchemaVersion: 2,
      sourceKind: 'wgsl',
      toolchain: { cookerId: 'mock-cooker', cookerVersion: '1.0', nagaVersion: '30.0' },
      source: {
        sourceUri: 'asset://shaders/skybox.wgsl',
        contentHash: '0'.repeat(64),
        byteLength: 100
      },
      bindings: [
        {
          group: 1,
          binding: 7,
          name: 'skyTexture',
          kind: 'texture',
          addressSpace: 'handle',
          access: 'read',
          typeName: 'texture_2d<f32>'
        },
        {
          group: 1,
          binding: 3,
          name: 'skySampler',
          kind: 'sampler',
          addressSpace: 'handle',
          access: 'read',
          typeName: 'sampler'
        }
      ],
      bufferLayouts: [],
      vertexInputs: [],
      fragmentOutputs: [{ location: 0, name: 'color', typeName: 'vec4<f32>' }],
      entryPoints: [
        {
          name: 'skyboxFragment',
          stage: 'fragment',
          bindings: [
            {
              group: 1,
              binding: 7, // Texture at slot 7
              name: 'skyTexture',
              kind: 'texture',
              addressSpace: 'handle',
              access: 'read',
              typeName: 'texture_2d<f32>'
            },
            {
              group: 1,
              binding: 3, // Sampler at slot 3
              name: 'skySampler',
              kind: 'sampler',
              addressSpace: 'handle',
              access: 'read',
              typeName: 'sampler'
            }
          ]
        }
      ],
      modules: {
        wgsl: '// mock',
        glslEs300: {
          'fragment:skyboxFragment': {
            source: '#version 300 es\nvoid main() {}',
            bindings: [
              {
                kind: 'combined-sampler',
                name: 'skyTexture_skySampler',
                texture: { group: 1, binding: 7 },
                sampler: { group: 1, binding: 3 }
              }
            ]
          }
        }
      }
    };

    const translator = createCookedArtifactWebGL2Translator(mockArtifact);
    const result = translator.translate({
      stage: 'fragment',
      entryPoint: 'skyboxFragment',
      wgsl: '// mock',
      constants: {},
      capabilities: [],
      approvedExtensions: [],
      clipDepthMode: 'zero-to-one'
    });

    // The sampler physical slot must be lowered to 7 (matching texture binding 7), NOT 3
    const samplerBinding = result.physicalBindings.find(
      (b) => b.group === 1 && b.binding === 3 && b.kind === 'sampler'
    );
    expect(samplerBinding).toBeDefined();
    expect(samplerBinding!.slot).toBe(7);

    const textureBinding = result.physicalBindings.find(
      (b) => b.group === 1 && b.binding === 7 && b.kind === 'texture'
    );
    expect(textureBinding).toBeDefined();
    expect(textureBinding!.slot).toBe(7);
  });
});
