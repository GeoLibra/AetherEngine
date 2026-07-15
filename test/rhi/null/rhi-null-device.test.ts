import { describe, expect, test } from 'vitest';
import { NullDevice } from '../../../src';

const BUFFER_USAGE_VERTEX = 1;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 16;

function createRenderTarget(device: NullDevice) {
  const color = device.createTexture({
    label: 'color',
    size: { width: 16, height: 8, depthOrArrayLayers: 1 },
    format: 'rgba8unorm',
    usage: TEXTURE_USAGE_RENDER_ATTACHMENT
  });

  return device.createRenderTarget({
    label: 'main-target',
    width: 16,
    height: 8,
    colorAttachments: [
      {
        texture: color,
        format: 'rgba8unorm',
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: [0, 0, 0, 1]
      }
    ]
  });
}

describe('NullDevice resources', () => {
  test('records immutable resource descriptors and disposes through the resource', () => {
    const device = new NullDevice();
    const descriptor = { label: 'vertices', size: 64, usage: BUFFER_USAGE_VERTEX };
    const buffer = device.createBuffer(descriptor);

    descriptor.size = 128;

    expect(buffer.size).toBe(64);
    expect(buffer.descriptor).toEqual({ label: 'vertices', size: 64, usage: BUFFER_USAGE_VERTEX });
    expect(buffer.state).toBe('live');

    buffer.dispose();
    buffer.dispose();

    expect(buffer.state).toBe('disposed');
  });

  test('tracks ownership and disposal state for render targets and texture views', () => {
    const firstDevice = new NullDevice();
    const texture = firstDevice.createTexture({
      label: 'owned-color',
      size: { width: 4, height: 4 },
      format: 'rgba8unorm',
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT
    });
    const firstView = texture.createView({ label: 'first-view' });
    const secondView = texture.createView({ label: 'second-view' });
    const target = firstDevice.createRenderTarget({
      label: 'owned-target',
      width: 4,
      height: 4,
      colorAttachments: [
        {
          texture,
          view: firstView,
          format: 'rgba8unorm',
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    });

    expect(firstView.id).not.toBe(secondView.id);
    target.dispose();

    expect(target.state).toBe('disposed');
    expect(() => target.createRenderPassDescriptor()).toThrow(
      'Resource "owned-target" has been disposed.'
    );
  });

  test('validates render target attachment dimensions and creates pass descriptors', () => {
    const device = new NullDevice();
    const target = createRenderTarget(device);
    const passDescriptor = target.createRenderPassDescriptor();

    expect(passDescriptor.label).toBe('main-target');
    expect(passDescriptor.colorAttachments).toHaveLength(1);
    expect(passDescriptor.colorAttachments[0]?.loadOp).toBe('clear');

    const mismatched = device.createTexture({
      label: 'too-small',
      size: { width: 8, height: 8, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT
    });

    expect(() =>
      device.createRenderTarget({
        width: 16,
        height: 8,
        colorAttachments: [
          {
            texture: mismatched,
            format: 'rgba8unorm',
            loadOp: 'load',
            storeOp: 'store'
          }
        ]
      })
    ).toThrow('Color attachment 0 size 8x8 does not match render target 16x8.');
  });

  test('records immutable texture descriptor sizes', () => {
    const device = new NullDevice();
    const size = { width: 8, height: 4 };
    const texture = device.createTexture({
      label: 'immutable-texture',
      size,
      format: 'rgba8unorm',
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT
    });

    size.width = 16;

    expect(texture.width).toBe(8);
    expect(texture.descriptor.size).toEqual({ width: 8, height: 4, depthOrArrayLayers: 1 });
  });

  test('reports texture view dimensions at the selected mip level', () => {
    const device = new NullDevice();
    const texture = device.createTexture({
      size: { width: 16, height: 8 },
      mipLevelCount: 5,
      format: 'rgba8unorm',
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT
    });

    const view = texture.createView({ baseMipLevel: 2 });

    expect([view.width, view.height]).toEqual([4, 2]);
    expect(() => texture.createView({ baseMipLevel: 5 })).toThrow(
      'Texture view baseMipLevel 5 is outside mipLevelCount 5.'
    );
  });

  test('validates depth-stencil attachment format and provided views', () => {
    const device = new NullDevice();
    const color = device.createTexture({
      label: 'view-color',
      size: { width: 8, height: 8 },
      format: 'rgba8unorm',
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT
    });
    const otherColor = device.createTexture({
      label: 'other-color',
      size: { width: 8, height: 8 },
      format: 'rgba8unorm',
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT
    });
    const depth = device.createTexture({
      label: 'depth',
      size: { width: 8, height: 8 },
      format: 'depth24plus',
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT
    });

    expect(() =>
      device.createRenderTarget({
        width: 8,
        height: 8,
        colorAttachments: [
          {
            texture: color,
            view: otherColor.createView(),
            format: 'rgba8unorm',
            loadOp: 'load',
            storeOp: 'store'
          }
        ]
      })
    ).toThrow('Color attachment 0 view does not belong to the attachment texture.');

    expect(() =>
      device.createRenderTarget({
        width: 8,
        height: 8,
        colorAttachments: [],
        depthStencilAttachment: {
          texture: depth,
          format: 'depth32float',
          depthLoadOp: 'clear',
          depthStoreOp: 'store'
        }
      })
    ).toThrow(
      'Depth-stencil attachment format "depth32float" does not match texture format "depth24plus".'
    );
  });

  test('rejects destroyed parent texture views and cross-device attachments', () => {
    const firstDevice = new NullDevice();
    const secondDevice = new NullDevice();
    const texture = firstDevice.createTexture({
      label: 'parent-texture',
      size: { width: 8, height: 8 },
      format: 'rgba8unorm',
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT
    });
    const view = texture.createView({ label: 'parent-view' });

    texture.dispose();

    expect(() =>
      firstDevice
        .createRenderTarget({
          width: 8,
          height: 8,
          colorAttachments: [
            {
              texture,
              view,
              format: 'rgba8unorm',
              loadOp: 'load',
              storeOp: 'store'
            }
          ]
        })
        .createRenderPassDescriptor()
    ).toThrow('Resource "parent-texture" has been disposed.');

    const foreignTexture = firstDevice.createTexture({
      label: 'foreign-color',
      size: { width: 4, height: 4 },
      format: 'rgba8unorm',
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT
    });

    expect(() =>
      secondDevice.createRenderTarget({
        width: 4,
        height: 4,
        colorAttachments: [
          {
            texture: foreignTexture,
            format: 'rgba8unorm',
            loadOp: 'load',
            storeOp: 'store'
          }
        ]
      })
    ).toThrow('Resource "foreign-color" belongs to a different NullDevice.');

    const multisampled = firstDevice.createTexture({
      label: 'msaa-color',
      size: { width: 4, height: 4 },
      format: 'rgba8unorm',
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT,
      sampleCount: 4
    });

    expect(() =>
      firstDevice.createRenderTarget({
        width: 4,
        height: 4,
        colorAttachments: [
          {
            texture: multisampled,
            format: 'rgba8unorm',
            loadOp: 'load',
            storeOp: 'store'
          }
        ]
      })
    ).toThrow('Color attachment 0 sampleCount 4 does not match render target sampleCount 1.');
  });
});
