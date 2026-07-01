import type { ScheduleLabel } from './types';

export const DEFAULT_SCHEDULES: ScheduleLabel[] = [
  'PreStartup',
  'Startup',
  'PostStartup',
  'First',
  'PreUpdate',
  'Update',
  'PostUpdate',
  'Last',
  'PreRender',
  'Render',
  'PostRender'
];

export const STARTUP_SCHEDULES: ScheduleLabel[] = ['PreStartup', 'Startup', 'PostStartup'];
export const FRAME_SCHEDULES: ScheduleLabel[] = [
  'First',
  'PreUpdate',
  'Update',
  'PostUpdate',
  'Last',
  'PreRender',
  'Render',
  'PostRender'
];
