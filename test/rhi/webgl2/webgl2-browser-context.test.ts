import { describe, expect, test } from 'vitest';

import { createBrowserWebGL2ContextPort } from '../../../src/rhi/webgl2/browser/context-port';

describe('browser WebGL2 context port', () => {
  test('requests explicit attributes, queries facts, and establishes deterministic state', () => {
    const gl = new FakeWebGL2Context();
    const requests: unknown[] = [];
    const canvas = {
      getContext(kind: string, attributes?: unknown): object | null {
        requests.push([kind, attributes]);
        return kind === 'webgl2' ? gl : null;
      },
      addEventListener(): void {},
      removeEventListener(): void {}
    };

    const port = createBrowserWebGL2ContextPort(canvas, {
      alpha: false,
      depth: true,
      stencil: true,
      powerPreference: 'high-performance'
    });
    if (port === null) throw new Error('Expected fake WebGL2 context to be accepted.');

    expect(requests).toEqual([
      [
        'webgl2',
        {
          alpha: false,
          antialias: false,
          depth: true,
          stencil: true,
          preserveDrawingBuffer: false,
          powerPreference: 'high-performance'
        }
      ]
    ]);
    expect(port.info).toEqual({ name: 'WebGL2', vendor: 'Fake Vendor', renderer: 'Fake Renderer' });
    expect([...port.extensions]).toEqual(['EXT_clip_control', 'EXT_color_buffer_float']);
    expect(port.limits).toMatchObject({
      maxTextureUnits: 16,
      maxUniformBufferBindings: 24,
      maxUniformBlockSize: 65_536,
      uniformBufferOffsetAlignment: 64
    });
    expect(port.precision).toMatchObject({
      vertexHighFloatBits: 23,
      fragmentHighFloatBits: 23
    });
    expect(port.formats.get('rgba8unorm')).toMatchObject({
      sample: true,
      filter: true,
      render: true,
      blend: true,
      sampleCounts: [1, 4]
    });
    expect(gl.calls).toEqual(
      expect.arrayContaining([
        ['pixelStorei', gl.PACK_ALIGNMENT, 4],
        ['pixelStorei', gl.UNPACK_ALIGNMENT, 4],
        ['disable', gl.BLEND],
        ['disable', gl.CULL_FACE],
        ['disable', gl.SCISSOR_TEST],
        ['disable', gl.STENCIL_TEST],
        ['depthMask', true],
        ['colorMask', true, true, true, true],
        ['bindBuffer', gl.ARRAY_BUFFER, null],
        ['bindBuffer', gl.UNIFORM_BUFFER, null],
        ['bindFramebuffer', gl.FRAMEBUFFER, null],
        ['bindVertexArray', null],
        ['activeTexture', gl.TEXTURE0]
      ])
    );
  });

  test('returns null without retrying another context kind when WebGL2 is unavailable', () => {
    let calls = 0;
    const canvas = {
      getContext(): null {
        calls += 1;
        return null;
      },
      addEventListener(): void {},
      removeEventListener(): void {}
    };

    expect(createBrowserWebGL2ContextPort(canvas)).toBeNull();
    expect(calls).toBe(1);
  });
});

class FakeWebGL2Context {
  readonly calls: unknown[][] = [];
  readonly PACK_ALIGNMENT = 0x0d05;
  readonly UNPACK_ALIGNMENT = 0x0cf5;
  readonly BLEND = 0x0be2;
  readonly CULL_FACE = 0x0b44;
  readonly SCISSOR_TEST = 0x0c11;
  readonly STENCIL_TEST = 0x0b90;
  readonly DEPTH_TEST = 0x0b71;
  readonly ARRAY_BUFFER = 0x8892;
  readonly ELEMENT_ARRAY_BUFFER = 0x8893;
  readonly UNIFORM_BUFFER = 0x8a11;
  readonly COPY_READ_BUFFER = 0x8f36;
  readonly COPY_WRITE_BUFFER = 0x8f37;
  readonly PIXEL_PACK_BUFFER = 0x88eb;
  readonly PIXEL_UNPACK_BUFFER = 0x88ec;
  readonly FRAMEBUFFER = 0x8d40;
  readonly RENDERBUFFER = 0x8d41;
  readonly TEXTURE0 = 0x84c0;
  readonly VENDOR = 0x1f00;
  readonly RENDERER = 0x1f01;
  readonly MAX_COMBINED_TEXTURE_IMAGE_UNITS = 0x8b4d;
  readonly MAX_UNIFORM_BUFFER_BINDINGS = 0x8a2f;
  readonly MAX_UNIFORM_BLOCK_SIZE = 0x8a30;
  readonly UNIFORM_BUFFER_OFFSET_ALIGNMENT = 0x8a34;
  readonly MAX_DRAW_BUFFERS = 0x8824;
  readonly MAX_COLOR_ATTACHMENTS = 0x8cdf;
  readonly MAX_SAMPLES = 0x8d57;
  readonly HIGH_FLOAT = 0x8df2;
  readonly VERTEX_SHADER = 0x8b31;
  readonly FRAGMENT_SHADER = 0x8b30;

  getSupportedExtensions(): string[] {
    return ['EXT_clip_control', 'EXT_color_buffer_float'];
  }
  getParameter(parameter: number): string | number {
    return (
      new Map<number, string | number>([
        [this.VENDOR, 'Fake Vendor'],
        [this.RENDERER, 'Fake Renderer'],
        [this.MAX_COMBINED_TEXTURE_IMAGE_UNITS, 16],
        [this.MAX_UNIFORM_BUFFER_BINDINGS, 24],
        [this.MAX_UNIFORM_BLOCK_SIZE, 65_536],
        [this.UNIFORM_BUFFER_OFFSET_ALIGNMENT, 64],
        [this.MAX_DRAW_BUFFERS, 4],
        [this.MAX_COLOR_ATTACHMENTS, 4],
        [this.MAX_SAMPLES, 4]
      ]).get(parameter) ?? 0
    );
  }
  getShaderPrecisionFormat(): { precision: number } {
    return { precision: 23 };
  }
  pixelStorei(...args: unknown[]): void {
    this.calls.push(['pixelStorei', ...args]);
  }
  disable(...args: unknown[]): void {
    this.calls.push(['disable', ...args]);
  }
  enable(...args: unknown[]): void {
    this.calls.push(['enable', ...args]);
  }
  colorMask(...args: unknown[]): void {
    this.calls.push(['colorMask', ...args]);
  }
  depthMask(...args: unknown[]): void {
    this.calls.push(['depthMask', ...args]);
  }
  stencilMask(...args: unknown[]): void {
    this.calls.push(['stencilMask', ...args]);
  }
  bindBuffer(...args: unknown[]): void {
    this.calls.push(['bindBuffer', ...args]);
  }
  bindFramebuffer(...args: unknown[]): void {
    this.calls.push(['bindFramebuffer', ...args]);
  }
  bindRenderbuffer(...args: unknown[]): void {
    this.calls.push(['bindRenderbuffer', ...args]);
  }
  bindVertexArray(...args: unknown[]): void {
    this.calls.push(['bindVertexArray', ...args]);
  }
  activeTexture(...args: unknown[]): void {
    this.calls.push(['activeTexture', ...args]);
  }
}
