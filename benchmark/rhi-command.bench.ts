import { bench, expect } from 'vitest';
import { NullDevice } from '../src';

bench(
  'records and submits 1000 deterministic command buffers',
  () => {
    const device = new NullDevice();
    const buffers = [];
    for (let index = 0; index < 1_000; index++) {
      const encoder = device.createCommandEncoder({ label: `frame-${index}` });
      encoder.pushDebugGroup('frame');
      encoder.popDebugGroup();
      buffers.push(encoder.finish());
    }
    const submission = device.queue.submit(buffers);
    expect(submission.status).toBe('completed');
    expect(device.queue.metrics().submitted).toBe(1);
  },
  { iterations: 1, warmupIterations: 0 }
);
