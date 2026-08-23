import { describe, expect, test } from 'vitest';

import { createBrowserWebGL2OperationPort } from '../../../src/rhi/webgl2/browser/operations';

describe('browser WebGL2 program diagnostics', () => {
  test('initializes active uniform blocks and combined samplers after linking', () => {
    const gl = new BindingProgramGL();
    const port = createBrowserWebGL2OperationPort(gl);

    port.createProgram?.({
      vertexSource: '#version 300 es\nvoid main() {}',
      fragmentSource: '#version 300 es\nvoid main() {}',
      bindings: [],
      programBindings: [
        { kind: 'uniform-buffer', name: 'Aether_0_0', slot: 2 },
        { kind: 'combined-sampler', name: 'aether_t0_1_s0_2', slot: 5 }
      ]
    });

    expect(gl.blockBindings).toEqual([{ blockIndex: 7, slot: 2 }]);
    expect(gl.samplerBindings).toEqual([{ location: 'aether_t0_1_s0_2', slot: 5 }]);
  });

  test('reports shader stage, driver log, and numbered generated source on compile failure', () => {
    const gl = new FailingShaderGL();
    const port = createBrowserWebGL2OperationPort(gl);

    expect(() =>
      port.createProgram?.({
        vertexSource: '#version 300 es\nvoid main() { broken(); }',
        fragmentSource: '#version 300 es\nvoid main() {}',
        bindings: []
      })
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringMatching(
          /WebGL2 vertex shader compilation failed[\s\S]*ERROR: 0:2: broken[\s\S]*2 \| void main\(\) \{ broken\(\); \}/
        )
      })
    );
  });

  test('reports both numbered stages on link failure', () => {
    const gl = new FailingLinkGL();
    const port = createBrowserWebGL2OperationPort(gl);

    expect(() =>
      port.createProgram?.({
        vertexSource: '#version 300 es\nvoid vertexMain() {}',
        fragmentSource: '#version 300 es\nvoid fragmentMain() {}',
        bindings: []
      })
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringMatching(
          /WebGL2 program link failed[\s\S]*link mismatch[\s\S]*vertex[\s\S]*2 \| void vertexMain\(\) \{\}[\s\S]*fragment[\s\S]*2 \| void fragmentMain\(\) \{\}/
        )
      })
    );
    expect(gl.deletedPrograms).toBe(1);
  });

  test('deletes the compiled vertex shader when fragment compilation fails', () => {
    const gl = new FailingFragmentShaderGL();
    const port = createBrowserWebGL2OperationPort(gl);

    expect(() =>
      port.createProgram?.({
        vertexSource: '#version 300 es\nvoid main() {}',
        fragmentSource: '#version 300 es\nvoid main() { broken(); }',
        bindings: []
      })
    ).toThrow(/fragment shader compilation failed/i);
    expect(gl.deletedShaders).toBe(2);
  });
});

class FailingShaderGL {
  readonly VERTEX_SHADER = 0x8b31;
  readonly FRAGMENT_SHADER = 0x8b30;
  readonly COMPILE_STATUS = 0x8b81;

  createShader(): object {
    return {};
  }
  shaderSource(): void {}
  compileShader(): void {}
  getShaderParameter(): boolean {
    return false;
  }
  getShaderInfoLog(): string {
    return 'ERROR: 0:2: broken';
  }
  deleteShader(): void {}
}

class FailingLinkGL extends FailingShaderGL {
  readonly LINK_STATUS = 0x8b82;
  deletedPrograms = 0;

  override getShaderParameter(): boolean {
    return true;
  }
  createProgram(): object {
    return {};
  }
  attachShader(): void {}
  linkProgram(): void {}
  getProgramParameter(): boolean {
    return false;
  }
  getProgramInfoLog(): string {
    return 'link mismatch';
  }
  deleteProgram(): void {
    this.deletedPrograms += 1;
  }
}

class FailingFragmentShaderGL extends FailingShaderGL {
  private compileChecks = 0;
  deletedShaders = 0;

  override getShaderParameter(): boolean {
    this.compileChecks += 1;
    return this.compileChecks === 1;
  }
  override deleteShader(): void {
    this.deletedShaders += 1;
  }
}

class BindingProgramGL extends FailingLinkGL {
  readonly INVALID_INDEX = 0xffffffff;
  readonly blockBindings: Array<{ blockIndex: number; slot: number }> = [];
  readonly samplerBindings: Array<{ location: string; slot: number }> = [];

  override getProgramParameter(): boolean {
    return true;
  }
  getUniformBlockIndex(_program: object, name: string): number {
    return name === 'Aether_0_0' ? 7 : this.INVALID_INDEX;
  }
  uniformBlockBinding(_program: object, blockIndex: number, slot: number): void {
    this.blockBindings.push({ blockIndex, slot });
  }
  useProgram(): void {}
  getUniformLocation(_program: object, name: string): string | null {
    return name === 'aether_t0_1_s0_2' ? name : null;
  }
  uniform1i(location: string, slot: number): void {
    this.samplerBindings.push({ location, slot });
  }
}
