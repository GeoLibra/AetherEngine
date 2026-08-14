import { describe, expect, test } from 'vitest';

import { createBrowserWebGL2OperationPort } from '../../../src/rhi/webgl2/browser/operation-port';

describe('browser WebGL2 native operations', () => {
  test('allocates resources and lowers top-left raster coordinates without mid-pass flushes', () => {
    const gl = new FakeOperationsGL();
    const port = createBrowserWebGL2OperationPort(gl);
    const buffer = port.createBuffer?.({ size: 128, usage: 0x20 });
    const texture = port.createTexture?.({
      size: { width: 80, height: 100, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: 0x10,
      mipLevelCount: 1,
      sampleCount: 1
    });
    const sampler = port.createSampler?.({ minFilter: 'linear', magFilter: 'nearest' });
    if (buffer === undefined || texture === undefined || sampler === undefined) {
      throw new Error('Expected browser operations to allocate resources.');
    }

    port.beginRenderPass?.({
      colorAttachments: [{ view: texture, loadOp: 'clear', storeOp: 'store' }]
    });
    port.setViewport?.(2, 10, 20, 30, 0.25, 0.75);
    port.setScissorRect?.(3, 15, 25, 35);
    port.setRasterState?.({ topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' });
    port.setDepthStencilState?.({
      enabled: true,
      depthWriteEnabled: true,
      depthCompare: 'less-equal'
    });
    port.draw?.(3, 2, 1, 0);
    port.bindIndexBuffer?.(buffer, 'uint16', 4, 12);
    port.drawIndexed?.(6, 1, 2, 0, 0);
    port.endRenderPass?.();

    expect(gl.calls).toEqual(
      expect.arrayContaining([
        ['bufferData', gl.ARRAY_BUFFER, 128, gl.DYNAMIC_DRAW],
        ['texStorage2D', gl.TEXTURE_2D, 1, gl.RGBA8, 80, 100],
        ['samplerParameteri', sampler, gl.TEXTURE_MIN_FILTER, gl.LINEAR],
        ['samplerParameteri', sampler, gl.TEXTURE_MAG_FILTER, gl.NEAREST],
        ['viewport', 2, 60, 20, 30],
        ['depthRange', 0.25, 0.75],
        ['scissor', 3, 50, 25, 35],
        ['enable', gl.CULL_FACE],
        ['cullFace', gl.BACK],
        ['frontFace', gl.CCW],
        ['enable', gl.DEPTH_TEST],
        ['depthMask', true],
        ['depthFunc', gl.LEQUAL],
        ['drawArraysInstanced', gl.TRIANGLES, 1, 3, 2],
        ['drawElementsInstanced', gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 8, 1]
      ])
    );
    expect(gl.calls.some(([name]) => name === 'flush')).toBe(false);

    port.deleteSampler?.(sampler);
    port.deleteTexture?.(texture);
    port.deleteBuffer?.(buffer);
    expect(gl.calls.slice(-3).map(([name]) => name)).toEqual([
      'deleteSampler',
      'deleteTexture',
      'deleteBuffer'
    ]);
  });

  test('rejects formats instead of silently allocating a different texture', () => {
    const port = createBrowserWebGL2OperationPort(new FakeOperationsGL());
    expect(() =>
      port.createTexture?.({
        size: { width: 1, height: 1, depthOrArrayLayers: 1 },
        format: 'bc1-rgba-unorm',
        usage: 0x10
      })
    ).toThrow(/unsupported WebGL2 texture format/i);
  });

  test('uploads and copies buffers before issuing one terminal fence flush', async () => {
    const gl = new FakeOperationsGL();
    const port = createBrowserWebGL2OperationPort(gl);
    const source = port.createBuffer?.({ size: 32, usage: 0x0c });
    const destination = port.createBuffer?.({ size: 32, usage: 0x0c });
    if (source === undefined || destination === undefined) throw new Error('Missing buffers.');
    gl.calls.length = 0;

    const upload = new Uint8Array([1, 2, 3, 4]);
    port.writeBuffer?.(source, 4, upload);
    port.copyBufferToBuffer?.(source, 4, destination, 8, 4);
    expect(gl.calls.map(([name]) => name)).not.toContain('flush');

    await port.createSubmissionFence?.();
    expect(gl.calls).toEqual(
      expect.arrayContaining([
        ['bufferSubData', gl.COPY_WRITE_BUFFER, 4, upload],
        ['copyBufferSubData', gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, 4, 8, 4],
        ['fenceSync', gl.SYNC_GPU_COMMANDS_COMPLETE, 0],
        ['flush'],
        ['deleteSync', gl.sync]
      ])
    );
    expect(gl.calls.filter(([name]) => name === 'flush')).toHaveLength(1);
  });

  test('creates checked framebuffers and vertex arrays with explicit lifetimes', () => {
    const gl = new FakeOperationsGL();
    const port = createBrowserWebGL2OperationPort(gl);
    const texture = port.createTexture?.({
      size: { width: 8, height: 8, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: 0x10
    });
    if (texture === undefined) throw new Error('Missing texture.');
    const framebuffer = port.createFramebuffer?.({
      colorAttachments: [{ view: texture, loadOp: 'load', storeOp: 'store' }]
    });
    const vertexBuffer = port.createBuffer?.({ size: 64, usage: 0x20 });
    if (vertexBuffer === undefined) throw new Error('Missing vertex buffer.');
    const vertexArray = port.createVertexArray?.({
      vertexLayout: [
        {
          arrayStride: 20,
          stepMode: 'vertex',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'unorm8x4' }
          ]
        }
      ],
      vertexBuffers: [{ slot: 0, buffer: vertexBuffer, offset: 4 }]
    });
    if (framebuffer === undefined || vertexArray === undefined)
      throw new Error('Missing GL objects.');

    expect(port.checkFramebufferStatus?.(framebuffer)).toEqual({
      complete: true,
      status: 'FRAMEBUFFER_COMPLETE'
    });
    port.bindFramebuffer?.(framebuffer);
    port.bindVertexArray?.(vertexArray);
    port.deleteVertexArray?.(vertexArray);
    port.deleteFramebuffer?.(framebuffer);
    expect(gl.calls).toEqual(
      expect.arrayContaining([
        ['framebufferTexture2D', gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0],
        ['vertexAttribPointer', 0, 3, gl.FLOAT, false, 20, 4],
        ['vertexAttribPointer', 1, 4, gl.UNSIGNED_BYTE, true, 20, 16],
        ['vertexAttribDivisor', 0, 0],
        ['bindVertexArray', vertexArray],
        ['deleteVertexArray', vertexArray],
        ['deleteFramebuffer', framebuffer]
      ])
    );
  });

  test('routes every MRT color attachment through drawBuffers', () => {
    const gl = new FakeOperationsGL();
    const port = createBrowserWebGL2OperationPort(gl);
    const first = port.createTexture?.({
      size: { width: 8, height: 8, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: 0x10
    });
    const second = port.createTexture?.({
      size: { width: 8, height: 8, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: 0x10
    });
    if (first === undefined || second === undefined) throw new Error('Missing MRT textures.');
    gl.calls.length = 0;

    port.createFramebuffer?.({
      colorAttachments: [
        { view: first, loadOp: 'load', storeOp: 'store' },
        { view: second, loadOp: 'load', storeOp: 'store' }
      ]
    });

    expect(gl.calls).toContainEqual([
      'drawBuffers',
      [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT0 + 1]
    ]);
  });

  test('configures a depth-only framebuffer and lowers its viewport from the depth extent', () => {
    const gl = new FakeOperationsGL();
    const port = createBrowserWebGL2OperationPort(gl);
    const depth = port.createTexture?.({
      size: { width: 80, height: 100, depthOrArrayLayers: 1 },
      format: 'depth24plus',
      usage: 0x10
    });
    if (depth === undefined) throw new Error('Missing depth texture.');
    const descriptor = {
      colorAttachments: [],
      depthStencilAttachment: { view: depth, depthLoadOp: 'load', depthStoreOp: 'store' }
    };
    gl.calls.length = 0;

    port.createFramebuffer?.(descriptor);
    port.beginRenderPass?.(descriptor);
    port.setViewport?.(2, 10, 20, 30, 0, 1);

    expect(gl.calls).toEqual(
      expect.arrayContaining([
        ['drawBuffers', [gl.NONE]],
        ['readBuffer', gl.NONE],
        ['viewport', 2, 60, 20, 30]
      ])
    );
  });

  test('rejects framebuffer attachments with inconsistent extents', () => {
    const gl = new FakeOperationsGL();
    const port = createBrowserWebGL2OperationPort(gl);
    const color = port.createTexture?.({
      size: { width: 80, height: 100, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: 0x10
    });
    const depth = port.createTexture?.({
      size: { width: 80, height: 64, depthOrArrayLayers: 1 },
      format: 'depth24plus',
      usage: 0x10
    });
    if (color === undefined || depth === undefined) throw new Error('Missing attachments.');

    expect(() =>
      port.createFramebuffer?.({
        colorAttachments: [{ view: color, loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: { view: depth, depthLoadOp: 'load', depthStoreOp: 'store' }
      })
    ).toThrow(/attachment extent mismatch.*80x100.*80x64/i);
  });

  test('attaches and lowers viewport against the selected mip subresource', () => {
    const gl = new FakeOperationsGL();
    const port = createBrowserWebGL2OperationPort(gl);
    const texture = port.createTexture?.({
      size: { width: 8, height: 8, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: 0x10,
      mipLevelCount: 2
    });
    if (texture === undefined) throw new Error('Missing mipmapped texture.');
    const descriptor = {
      colorAttachments: [
        { view: texture, mipLevel: 1, width: 4, height: 4, loadOp: 'load', storeOp: 'store' }
      ]
    };
    gl.calls.length = 0;

    port.createFramebuffer?.(descriptor);
    port.beginRenderPass?.(descriptor);
    port.setViewport?.(0, 1, 4, 2, 0, 1);

    expect(gl.calls).toEqual(
      expect.arrayContaining([
        ['framebufferTexture2D', gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 1],
        ['viewport', 0, 1, 4, 2]
      ])
    );
  });

  test('lowers baseline 2D texture uploads and buffer-texture copies without readback', () => {
    const gl = new FakeOperationsGL();
    const port = createBrowserWebGL2OperationPort(gl);
    const texture = port.createTexture?.({
      size: { width: 4, height: 2, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: 0x13
    });
    const other = port.createTexture?.({
      size: { width: 4, height: 2, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: 0x13
    });
    const buffer = port.createBuffer?.({ size: 512, usage: 0x0c });
    if (texture === undefined || other === undefined || buffer === undefined) {
      throw new Error('Missing copy resources.');
    }
    gl.calls.length = 0;
    const pixels = new Uint8Array(32);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 8);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 8);
    gl.calls.length = 0;

    port.writeTexture?.(
      { texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
      pixels,
      { offset: 0, bytesPerRow: 16, rowsPerImage: 2 },
      { width: 4, height: 2, depthOrArrayLayers: 1 }
    );
    port.copyBufferToTexture?.(
      { buffer, offset: 256, bytesPerRow: 256, rowsPerImage: 2 },
      { texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
      { width: 4, height: 2, depthOrArrayLayers: 1 }
    );
    port.copyTextureToBuffer?.(
      { texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
      { buffer, offset: 256, bytesPerRow: 256, rowsPerImage: 2 },
      { width: 4, height: 2, depthOrArrayLayers: 1 }
    );
    port.copyTextureToTexture?.(
      { texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
      { texture: other, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
      { width: 4, height: 2, depthOrArrayLayers: 1 }
    );

    expect(gl.calls).toEqual(
      expect.arrayContaining([
        ['pixelStorei', gl.UNPACK_ALIGNMENT, 4],
        ['pixelStorei', gl.PACK_ALIGNMENT, 4],
        ['texSubImage2D', gl.TEXTURE_2D, 0, 0, 0, 4, 2, gl.RGBA, gl.UNSIGNED_BYTE, pixels],
        ['texSubImage2D', gl.TEXTURE_2D, 0, 0, 0, 4, 2, gl.RGBA, gl.UNSIGNED_BYTE, 256],
        ['readPixels', 0, 0, 4, 2, gl.RGBA, gl.UNSIGNED_BYTE, 256],
        ['copyTexSubImage2D', gl.TEXTURE_2D, 0, 0, 0, 0, 0, 4, 2]
      ])
    );
    expect(gl.calls.some(([name]) => name === 'getBufferSubData')).toBe(false);
    expect(gl.calls.some(([name]) => name === 'flush')).toBe(false);
  });

  test('attaches the selected source mip for texture readback', () => {
    const gl = new FakeOperationsGL();
    const port = createBrowserWebGL2OperationPort(gl);
    const texture = port.createTexture?.({
      size: { width: 8, height: 8, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: 0x13,
      mipLevelCount: 2
    });
    const buffer = port.createBuffer?.({ size: 512, usage: 0x0c });
    if (texture === undefined || buffer === undefined) throw new Error('Missing copy resources.');
    gl.calls.length = 0;

    port.copyTextureToBuffer?.(
      { texture, mipLevel: 1, origin: { x: 0, y: 0, z: 0 } },
      { buffer, offset: 256, bytesPerRow: 256, rowsPerImage: 4 },
      { width: 4, height: 4, depthOrArrayLayers: 1 }
    );

    expect(gl.calls).toContainEqual([
      'framebufferTexture2D',
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      1
    ]);
  });

  test('applies load/store operations and resolves without a pass-boundary flush', () => {
    const gl = new FakeOperationsGL();
    const port = createBrowserWebGL2OperationPort(gl);
    const source = port.createTexture?.({
      size: { width: 16, height: 12, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: 0x10
    });
    const resolveTarget = port.createTexture?.({
      size: { width: 16, height: 12, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: 0x10
    });
    if (source === undefined || resolveTarget === undefined)
      throw new Error('Missing attachments.');
    const descriptor = {
      colorAttachments: [
        {
          view: source,
          resolveTarget,
          loadOp: 'clear',
          storeOp: 'discard',
          clearValue: { r: 0.1, g: 0.2, b: 0.3, a: 1 }
        }
      ]
    };
    gl.calls.length = 0;

    port.applyRenderPassLoadOperations?.(descriptor);
    port.applyRenderPassStoreOperations?.(descriptor);
    port.resolveRenderPass?.(descriptor);

    expect(gl.calls).toEqual(
      expect.arrayContaining([
        ['clearBufferfv', gl.COLOR, 0, new Float32Array([0.1, 0.2, 0.3, 1])],
        ['invalidateFramebuffer', gl.FRAMEBUFFER, [gl.COLOR_ATTACHMENT0]],
        ['blitFramebuffer', 0, 0, 16, 12, 0, 0, 16, 12, gl.COLOR_BUFFER_BIT, gl.NEAREST]
      ])
    );
    expect(gl.calls.some(([name]) => name === 'flush')).toBe(false);
  });

  test('resolves between the selected source and target mip extents', () => {
    const gl = new FakeOperationsGL();
    const port = createBrowserWebGL2OperationPort(gl);
    const source = port.createTexture?.({
      size: { width: 16, height: 16, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: 0x10,
      mipLevelCount: 2
    });
    const target = port.createTexture?.({
      size: { width: 16, height: 16, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: 0x10,
      mipLevelCount: 2
    });
    if (source === undefined || target === undefined) throw new Error('Missing resolve textures.');
    gl.calls.length = 0;

    port.resolveRenderPass?.({
      colorAttachments: [
        {
          view: source,
          mipLevel: 1,
          width: 8,
          height: 8,
          resolveTarget: target,
          resolveTargetMipLevel: 1,
          resolveTargetWidth: 8,
          resolveTargetHeight: 8,
          loadOp: 'load',
          storeOp: 'store'
        }
      ]
    });

    expect(gl.calls).toEqual(
      expect.arrayContaining([
        [
          'framebufferTexture2D',
          gl.DRAW_FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D,
          target,
          1
        ],
        ['blitFramebuffer', 0, 0, 8, 8, 0, 0, 8, 8, gl.COLOR_BUFFER_BIT, gl.NEAREST]
      ])
    );
  });
});

class FakeOperationsGL {
  readonly calls: unknown[][] = [];
  readonly ARRAY_BUFFER = 0x8892;
  readonly ELEMENT_ARRAY_BUFFER = 0x8893;
  readonly DYNAMIC_DRAW = 0x88e8;
  readonly TEXTURE_2D = 0x0de1;
  readonly RGBA8 = 0x8058;
  readonly DEPTH_COMPONENT24 = 0x81a6;
  readonly TEXTURE_MIN_FILTER = 0x2801;
  readonly TEXTURE_MAG_FILTER = 0x2800;
  readonly LINEAR = 0x2601;
  readonly NEAREST = 0x2600;
  readonly TRIANGLES = 0x0004;
  readonly UNSIGNED_SHORT = 0x1403;
  readonly COPY_READ_BUFFER = 0x8f36;
  readonly COPY_WRITE_BUFFER = 0x8f37;
  readonly SYNC_GPU_COMMANDS_COMPLETE = 0x9117;
  readonly CONDITION_SATISFIED = 0x911c;
  readonly ALREADY_SIGNALED = 0x911a;
  readonly WAIT_FAILED = 0x911d;
  readonly FRAMEBUFFER = 0x8d40;
  readonly FRAMEBUFFER_COMPLETE = 0x8cd5;
  readonly COLOR_ATTACHMENT0 = 0x8ce0;
  readonly NONE = 0;
  readonly DEPTH_ATTACHMENT = 0x8d00;
  readonly PIXEL_PACK_BUFFER = 0x88eb;
  readonly PIXEL_UNPACK_BUFFER = 0x88ec;
  readonly RGBA = 0x1908;
  readonly UNSIGNED_BYTE = 0x1401;
  readonly FLOAT = 0x1406;
  readonly UNPACK_ROW_LENGTH = 0x0cf2;
  readonly PACK_ROW_LENGTH = 0x0d02;
  readonly UNPACK_ALIGNMENT = 0x0cf5;
  readonly PACK_ALIGNMENT = 0x0d05;
  readonly COLOR = 0x1800;
  readonly DEPTH = 0x1801;
  readonly STENCIL = 0x1802;
  readonly DRAW_FRAMEBUFFER = 0x8ca9;
  readonly COLOR_BUFFER_BIT = 0x4000;
  readonly CULL_FACE = 0x0b44;
  readonly DEPTH_TEST = 0x0b71;
  readonly BACK = 0x0405;
  readonly FRONT = 0x0404;
  readonly CCW = 0x0901;
  readonly CW = 0x0900;
  readonly LEQUAL = 0x0203;
  readonly sync = { kind: 'sync' };
  private nextId = 1;

  createBuffer(): object {
    return { kind: 'buffer', id: this.nextId++ };
  }
  bindBuffer(...args: unknown[]): void {
    this.calls.push(['bindBuffer', ...args]);
  }
  bufferData(...args: unknown[]): void {
    this.calls.push(['bufferData', ...args]);
  }
  bufferSubData(...args: unknown[]): void {
    this.calls.push(['bufferSubData', ...args]);
  }
  copyBufferSubData(...args: unknown[]): void {
    this.calls.push(['copyBufferSubData', ...args]);
  }
  deleteBuffer(...args: unknown[]): void {
    this.calls.push(['deleteBuffer', ...args]);
  }
  createTexture(): object {
    return { kind: 'texture', id: this.nextId++ };
  }
  bindTexture(...args: unknown[]): void {
    this.calls.push(['bindTexture', ...args]);
  }
  texStorage2D(...args: unknown[]): void {
    this.calls.push(['texStorage2D', ...args]);
  }
  texSubImage2D(...args: unknown[]): void {
    this.calls.push(['texSubImage2D', ...args]);
  }
  copyTexSubImage2D(...args: unknown[]): void {
    this.calls.push(['copyTexSubImage2D', ...args]);
  }
  readPixels(...args: unknown[]): void {
    this.calls.push(['readPixels', ...args]);
  }
  pixelStorei(...args: unknown[]): void {
    this.calls.push(['pixelStorei', ...args]);
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
  drawBuffers(...args: unknown[]): void {
    this.calls.push(['drawBuffers', ...args]);
  }
  readBuffer(...args: unknown[]): void {
    this.calls.push(['readBuffer', ...args]);
  }
  checkFramebufferStatus(): number {
    return this.FRAMEBUFFER_COMPLETE;
  }
  deleteFramebuffer(...args: unknown[]): void {
    this.calls.push(['deleteFramebuffer', ...args]);
  }
  clearBufferfv(...args: unknown[]): void {
    this.calls.push(['clearBufferfv', ...args]);
  }
  clearBufferiv(...args: unknown[]): void {
    this.calls.push(['clearBufferiv', ...args]);
  }
  invalidateFramebuffer(...args: unknown[]): void {
    this.calls.push(['invalidateFramebuffer', ...args]);
  }
  blitFramebuffer(...args: unknown[]): void {
    this.calls.push(['blitFramebuffer', ...args]);
  }
  createVertexArray(): object {
    return { kind: 'vertex-array', id: this.nextId++ };
  }
  bindVertexArray(...args: unknown[]): void {
    this.calls.push(['bindVertexArray', ...args]);
  }
  deleteVertexArray(...args: unknown[]): void {
    this.calls.push(['deleteVertexArray', ...args]);
  }
  enableVertexAttribArray(...args: unknown[]): void {
    this.calls.push(['enableVertexAttribArray', ...args]);
  }
  vertexAttribPointer(...args: unknown[]): void {
    this.calls.push(['vertexAttribPointer', ...args]);
  }
  vertexAttribIPointer(...args: unknown[]): void {
    this.calls.push(['vertexAttribIPointer', ...args]);
  }
  vertexAttribDivisor(...args: unknown[]): void {
    this.calls.push(['vertexAttribDivisor', ...args]);
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
  viewport(...args: unknown[]): void {
    this.calls.push(['viewport', ...args]);
  }
  depthRange(...args: unknown[]): void {
    this.calls.push(['depthRange', ...args]);
  }
  scissor(...args: unknown[]): void {
    this.calls.push(['scissor', ...args]);
  }
  enable(...args: unknown[]): void {
    this.calls.push(['enable', ...args]);
  }
  disable(...args: unknown[]): void {
    this.calls.push(['disable', ...args]);
  }
  cullFace(...args: unknown[]): void {
    this.calls.push(['cullFace', ...args]);
  }
  frontFace(...args: unknown[]): void {
    this.calls.push(['frontFace', ...args]);
  }
  depthMask(...args: unknown[]): void {
    this.calls.push(['depthMask', ...args]);
  }
  depthFunc(...args: unknown[]): void {
    this.calls.push(['depthFunc', ...args]);
  }
  drawArraysInstanced(...args: unknown[]): void {
    this.calls.push(['drawArraysInstanced', ...args]);
  }
  drawElementsInstanced(...args: unknown[]): void {
    this.calls.push(['drawElementsInstanced', ...args]);
  }
  flush(): void {
    this.calls.push(['flush']);
  }
  fenceSync(...args: unknown[]): object {
    this.calls.push(['fenceSync', ...args]);
    return this.sync;
  }
  clientWaitSync(): number {
    return this.CONDITION_SATISFIED;
  }
  deleteSync(...args: unknown[]): void {
    this.calls.push(['deleteSync', ...args]);
  }
}
