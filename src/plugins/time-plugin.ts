import { definePlugin } from '../app/utils';
import {
  FixedTime,
  FixedTimeResource,
  FrameTime,
  FrameTimeResource,
  TimeControl,
  TimeControlResource,
  TimeDiagnostics,
  TimeDiagnosticsResource,
  TimePolicy,
  TimePolicyResource,
  TimeRuntime,
  TimeRuntimeResource
} from '../app/time';
import type { TimePolicyOptions } from '../app/types';

export function createTimePlugin(options: TimePolicyOptions = {}) {
  const policyOptions = Object.freeze({ ...options });
  return definePlugin({
    id: 'aether.time',
    build(builder) {
      const policy = new TimePolicy(policyOptions);
      builder.insertResource(TimePolicyResource, policy);
      builder.insertResource(FrameTimeResource, new FrameTime());
      builder.insertResource(
        FixedTimeResource,
        new FixedTime(policy.fixedStep, policy.maxSubsteps)
      );
      builder.insertResource(TimeControlResource, new TimeControl());
      builder.insertResource(TimeDiagnosticsResource, new TimeDiagnostics());
      builder.insertResource(TimeRuntimeResource, new TimeRuntime());
    }
  });
}

export const TimePlugin = createTimePlugin();
