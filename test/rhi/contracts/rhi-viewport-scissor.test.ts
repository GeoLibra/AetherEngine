import { describe, expect, test } from 'vitest';
import { NullDevice } from '../../../src';

const TEXTURE_USAGE_RENDER_ATTACHMENT = 16;

function createPass(device: NullDevice) {
  const color = device.createTexture({
    label: 'viewport-color',
    size: { width: 16, height: 8 },
    format: 'rgba8unorm',
    usage: TEXTURE_USAGE_RENDER_ATTACHMENT
  });
  const target = device.createRenderTarget({
    label: 'viewport-target',
    width: 16,
    height: 8,
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

function createRenderAttachment(device: NullDevice, label: string, width: number, height: number) {
  return device.createTexture({
    label,
    size: { width, height },
    format: 'rgba8unorm',
    usage: TEXTURE_USAGE_RENDER_ATTACHMENT
  });
}

describe('RHI viewport and scissor pass state', () => {
  test('records deterministic viewport and scissor commands before pipeline binding', () => {
    const device = new NullDevice();
    const { encoder, pass } = createPass(device);
    const pipeline = device.createRenderPipeline({ label: 'viewport-pipeline' });

    pass.setViewport(1.5, 2.25, 10, 4, 0.25, 0.75);
    pass.setScissorRect(1, 2, 10, 4);
    pass.setPipeline(pipeline);
    pass.end();

    expect(encoder.finish().getCommandStream()).toEqual([
      { kind: 'beginRenderPass', label: 'viewport-target', colorAttachmentCount: 1 },
      {
        kind: 'setViewport',
        x: 1.5,
        y: 2.25,
        width: 10,
        height: 4,
        minDepth: 0.25,
        maxDepth: 0.75
      },
      { kind: 'setScissorRect', x: 1, y: 2, width: 10, height: 4 },
      {
        kind: 'setRenderPipeline',
        pipeline: { kind: 'render-pipeline', id: pipeline.id, label: 'viewport-pipeline' }
      },
      { kind: 'endRenderPass', label: 'viewport-target' }
    ]);
  });

  test('allows viewport and scissor state around pipeline changes', () => {
    const device = new NullDevice();
    const { pass } = createPass(device);
    const firstPipeline = device.createRenderPipeline({ label: 'first' });
    const secondPipeline = device.createRenderPipeline({ label: 'second' });

    expect(() => {
      pass.setViewport(0, 0, 16, 8, 0, 1);
      pass.setPipeline(firstPipeline);
      pass.setScissorRect(0, 0, 8, 4);
      pass.setPipeline(secondPipeline);
      pass.setViewport(2, 2, 4, 4, 0.1, 0.9);
      pass.end();
    }).not.toThrow();
  });

  test('accepts viewport and scissor rectangles exactly matching attachment bounds', () => {
    const device = new NullDevice();
    const { pass } = createPass(device);

    expect(() => {
      pass.setViewport(0, 0, 16, 8, 0, 1);
      pass.setScissorRect(0, 0, 16, 8);
      pass.end();
    }).not.toThrow();
  });

  test('rejects viewport and scissor calls after pass end', () => {
    const device = new NullDevice();
    const { pass } = createPass(device);

    pass.end();

    expect(() => pass.setViewport(0, 0, 1, 1, 0, 1)).toThrow(
      'Render pass "viewport-target" has already ended.'
    );
    expect(() => pass.setScissorRect(0, 0, 1, 1)).toThrow(
      'Render pass "viewport-target" has already ended.'
    );
  });

  test('rejects invalid viewport values', () => {
    const device = new NullDevice();
    const { pass } = createPass(device);

    expect(() => pass.setViewport(Number.NaN, 0, 1, 1, 0, 1)).toThrow(
      'Viewport x must be a finite number.'
    );
    expect(() => pass.setViewport(0, 0, -1, 1, 0, 1)).toThrow(
      'Viewport width must be non-negative.'
    );
    expect(() => pass.setViewport(0, 0, 1, 1, -0.1, 1)).toThrow(
      'Viewport minDepth must be between 0 and 1.'
    );
    expect(() => pass.setViewport(0, 0, 1, 1, 0, 1.1)).toThrow(
      'Viewport maxDepth must be between 0 and 1.'
    );
  });

  test('rejects invalid scissor values', () => {
    const device = new NullDevice();
    const { pass } = createPass(device);

    expect(() => pass.setScissorRect(Number.POSITIVE_INFINITY, 0, 1, 1)).toThrow(
      'Scissor x must be a finite integer.'
    );
    expect(() => pass.setScissorRect(0.5, 0, 1, 1)).toThrow('Scissor x must be a finite integer.');
    expect(() => pass.setScissorRect(0, -1, 1, 1)).toThrow('Scissor y must be non-negative.');
    expect(() => pass.setScissorRect(0, 0, 1, -1)).toThrow('Scissor height must be non-negative.');
  });

  test('rejects viewport rectangles outside attachment bounds', () => {
    const device = new NullDevice();
    const { pass } = createPass(device);

    expect(() => pass.setViewport(-1, 0, 1, 1, 0, 1)).toThrow(
      'Viewport rectangle -1,0 1x1 exceeds render pass extent 16x8.'
    );
    expect(() => pass.setViewport(15, 0, 2, 1, 0, 1)).toThrow(
      'Viewport rectangle 15,0 2x1 exceeds render pass extent 16x8.'
    );
    expect(() => pass.setViewport(0, 7, 1, 2, 0, 1)).toThrow(
      'Viewport rectangle 0,7 1x2 exceeds render pass extent 16x8.'
    );
  });

  test('rejects scissor rectangles outside attachment bounds', () => {
    const device = new NullDevice();
    const { pass } = createPass(device);

    expect(() => pass.setScissorRect(15, 0, 2, 1)).toThrow(
      'Scissor rectangle 15,0 2x1 exceeds render pass extent 16x8.'
    );
    expect(() => pass.setScissorRect(0, 7, 1, 2)).toThrow(
      'Scissor rectangle 0,7 1x2 exceeds render pass extent 16x8.'
    );
  });

  test('infers bounds from depth-stencil-only render passes', () => {
    const device = new NullDevice();
    const depth = device.createTexture({
      label: 'depth-only',
      size: { width: 12, height: 6 },
      format: 'depth24plus',
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      label: 'depth-pass',
      colorAttachments: [],
      depthStencilAttachment: {
        view: depth.createView(),
        depthLoadOp: 'clear',
        depthStoreOp: 'store'
      }
    });

    expect(() => {
      pass.setViewport(0, 0, 12, 6, 0, 1);
      pass.setScissorRect(0, 0, 12, 6);
      pass.end();
    }).not.toThrow();
  });

  test('validates multiple attachment sizes when beginning a render pass', () => {
    const device = new NullDevice();
    const first = createRenderAttachment(device, 'first-color', 16, 8);
    const second = createRenderAttachment(device, 'second-color', 16, 8);
    const encoder = device.createCommandEncoder();

    expect(() =>
      encoder.beginRenderPass({
        label: 'matching-attachments',
        colorAttachments: [
          { view: first.createView(), loadOp: 'clear', storeOp: 'store' },
          { view: second.createView(), loadOp: 'clear', storeOp: 'store' }
        ]
      })
    ).not.toThrow();
  });

  test('rejects render passes with no attachments or mismatched attachment sizes', () => {
    const device = new NullDevice();
    const first = createRenderAttachment(device, 'first-color', 16, 8);
    const second = createRenderAttachment(device, 'second-color', 8, 8);

    expect(() =>
      device.createCommandEncoder().beginRenderPass({
        label: 'empty-pass',
        colorAttachments: []
      })
    ).toThrow('Render pass "empty-pass" requires at least one attachment.');

    expect(() =>
      device.createCommandEncoder().beginRenderPass({
        label: 'mismatch-pass',
        colorAttachments: [
          { view: first.createView(), loadOp: 'clear', storeOp: 'store' },
          { view: second.createView(), loadOp: 'clear', storeOp: 'store' }
        ]
      })
    ).toThrow(
      'Render pass "mismatch-pass" attachment at index 1 size 8x8 does not match render pass extent 16x8.'
    );
  });
});
