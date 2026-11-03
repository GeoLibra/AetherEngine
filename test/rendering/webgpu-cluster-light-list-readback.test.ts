import { expect, test } from 'vitest';
import { createWebGpuClusterLightListReadbackTicket } from '../../src';
import { NullDevice } from '../../src/rhi';

test('reads and cluster-decodes completed WebGPU storage copies', async () => {
  const device = new NullDevice();
  const buffer = (size: number) => device.createBuffer({ size, usage: (1 << 0) | (1 << 3) });
  const directional = buffer(4);
  const headers = buffer(16);
  const indices = buffer(8);
  const overflow = buffer(16);
  device.queue.writeBuffer(directional, 0, new Uint32Array([7]));
  device.queue.writeBuffer(headers, 0, new Uint32Array([2, 0, 2, 0]));
  device.queue.writeBuffer(indices, 0, new Uint32Array([4, 5]));
  device.queue.writeBuffer(overflow, 0, new Uint32Array([1, 1, 2, 0]));
  const ticket = createWebGpuClusterLightListReadbackTicket({
    directional,
    headers,
    indices,
    overflow
  });
  await expect(ticket.read()).resolves.toEqual({
    directionalIndices: [7],
    headers: [{ cluster: 2, offset: 0, count: 2, overflowed: false }],
    lightIndices: [4, 5],
    overflowed: false
  });
});
