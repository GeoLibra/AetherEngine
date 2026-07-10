import { definePlugin } from '../app/plugin';
import {
  FixedTime,
  FrameTime,
  TimeControl,
  TimeDiagnostics,
  TimePolicy,
  TimeRuntime
} from '../app/time';
import type { TimePolicyOptions } from '../app/time-types';

export function createTimePlugin(options: TimePolicyOptions = {}) {
  const policyOptions = Object.freeze({ ...options });
  return definePlugin({
    id: 'aether.time',
    build(builder) {
      const policy = new TimePolicy(policyOptions);
      builder.insertResource(policy);
      builder.insertResource(new FrameTime());
      builder.insertResource(new FixedTime(policy.fixedStep, policy.maxSubsteps));
      builder.insertResource(new TimeControl());
      builder.insertResource(new TimeDiagnostics());
      builder.insertResource(new TimeRuntime());
    }
  });
}

export const TimePlugin = createTimePlugin();
