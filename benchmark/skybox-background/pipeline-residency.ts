import { NullDevice } from '../../src/rhi';
import {
  prepareBackgroundPipeline,
  clearBackgroundPipelineCache
} from '../../src/rendering/background';

/** Exercises actual device-local pipeline reuse against a cold-allocation reference. */
export function measureBackgroundPipelineResidency(frames: number, reuse: boolean) {
  const device = new NullDevice();
  const pipelines = new Set<unknown>();
  for (let frame = 0; frame < frames; frame++) {
    const lease = prepareBackgroundPipeline(device, { colorFormat: 'rgba16float' });
    pipelines.add(lease.prepared.pipeline);
    lease.release();
    if (!reuse) clearBackgroundPipelineCache(device);
  }
  clearBackgroundPipelineCache(device);
  device.destroy();
  return { frames, pipelineAllocations: pipelines.size };
}
