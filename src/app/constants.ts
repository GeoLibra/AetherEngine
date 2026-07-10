import type { ScheduleLabel } from './types';

export const DEFAULT_SCHEDULES: ScheduleLabel[] = [
  'PreStartup',
  'Startup',
  'PostStartup',
  'First',
  'PreUpdate',
  'FixedFirst',
  'FixedPreUpdate',
  'FixedUpdate',
  'FixedPostUpdate',
  'FixedLast',
  'Update',
  'PostUpdate',
  'Last',
  'PreRender',
  'Render',
  'PostRender'
];

export const STARTUP_SCHEDULES: ScheduleLabel[] = ['PreStartup', 'Startup', 'PostStartup'];
export const FRAME_BEFORE_FIXED_SCHEDULES: ScheduleLabel[] = ['First', 'PreUpdate'];
export const FIXED_SCHEDULES: ScheduleLabel[] = [
  'FixedFirst',
  'FixedPreUpdate',
  'FixedUpdate',
  'FixedPostUpdate',
  'FixedLast'
];
export const FRAME_AFTER_FIXED_SCHEDULES: ScheduleLabel[] = [
  'Update',
  'PostUpdate',
  'Last',
  'PreRender',
  'Render',
  'PostRender'
];
