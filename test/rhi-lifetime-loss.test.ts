import { describe, expect, test } from 'vitest';
import { NullDevice } from '../src';

describe('Null RHI lifetime and loss', () => {
  test('resources own idempotent disposal and inherit device generation', () => {
    const device = new NullDevice();
    const buffer = device.createBuffer({ label: 'owned', size: 16, usage: 1 });

    expect(device.state).toBe('live');
    expect(buffer.state).toBe('live');
    expect(buffer.generation).toBe(device.generation);

    buffer.dispose();
    buffer.dispose();

    expect(buffer.state).toBe('disposed');
    expect(() => device.queue.writeBuffer(buffer, 0, new Uint8Array([1]))).toThrow(
      'Resource "owned" has been disposed.'
    );
  });

  test('device loss transitions old handles and resolves immutable loss info', async () => {
    const device = new NullDevice();
    const texture = device.createTexture({
      label: 'color',
      size: { width: 4, height: 4 },
      format: 'rgba8unorm',
      usage: 16
    });
    const view = texture.createView({ label: 'color-view' });

    device.loseForTesting('context-lost', 'simulated loss');

    expect(device.state).toBe('lost');
    expect(texture.state).toBe('device-lost');
    expect(view.state).toBe('device-lost');
    await expect(device.lost).resolves.toEqual({
      reason: 'context-lost',
      message: 'simulated loss',
      generation: device.generation
    });
    expect(Object.isFrozen(await device.lost)).toBe(true);
    expect(() => texture.createView()).toThrow('Resource "color" belongs to a lost device.');
    expect(() => device.createBuffer({ size: 4, usage: 1 })).toThrow(
      'NullDevice is lost.'
    );
  });

  test('never reuses a device generation', () => {
    const first = new NullDevice();
    const second = new NullDevice();
    expect(second.generation).not.toBe(first.generation);
  });

  test('invalidates pre-loss command encoders', () => {
    const device = new NullDevice();
    const encoder = device.createCommandEncoder({ label: 'stale-encoder' });

    device.loseForTesting('unknown', 'encoder invalidated');

    expect(() => encoder.finish()).toThrow(
      'Command encoder "stale-encoder" belongs to a lost device.'
    );
  });

  test('destroys the device idempotently and resolves the loss contract', async () => {
    const device = new NullDevice();
    const buffer = device.createBuffer({ size: 4, usage: 1 });

    device.destroy();
    device.destroy();

    expect(device.state).toBe('destroyed');
    expect(buffer.state).toBe('device-lost');
    await expect(device.lost).resolves.toEqual({
      reason: 'destroyed',
      message: 'NullDevice was destroyed.',
      generation: device.generation
    });
  });
});
