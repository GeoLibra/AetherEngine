export const CoreSchedule = Object.freeze({
  PreStartup: 'PreStartup',
  Startup: 'Startup',
  PostStartup: 'PostStartup',
  First: 'First',
  PreUpdate: 'PreUpdate',
  FixedFirst: 'FixedFirst',
  FixedPreUpdate: 'FixedPreUpdate',
  FixedUpdate: 'FixedUpdate',
  FixedPostUpdate: 'FixedPostUpdate',
  FixedLast: 'FixedLast',
  Update: 'Update',
  PostUpdate: 'PostUpdate',
  Last: 'Last',
  PreRender: 'PreRender',
  Render: 'Render',
  PostRender: 'PostRender',
  FrameCleanup: 'FrameCleanup'
} as const);

export type CoreSchedule = (typeof CoreSchedule)[keyof typeof CoreSchedule];

export const DEFAULT_SCHEDULES: readonly CoreSchedule[] = Object.freeze([
  CoreSchedule.PreStartup,
  CoreSchedule.Startup,
  CoreSchedule.PostStartup,
  CoreSchedule.First,
  CoreSchedule.PreUpdate,
  CoreSchedule.FixedFirst,
  CoreSchedule.FixedPreUpdate,
  CoreSchedule.FixedUpdate,
  CoreSchedule.FixedPostUpdate,
  CoreSchedule.FixedLast,
  CoreSchedule.Update,
  CoreSchedule.PostUpdate,
  CoreSchedule.Last,
  CoreSchedule.PreRender,
  CoreSchedule.Render,
  CoreSchedule.PostRender,
  CoreSchedule.FrameCleanup
]);

export const STARTUP_SCHEDULES: readonly CoreSchedule[] = Object.freeze([
  CoreSchedule.PreStartup,
  CoreSchedule.Startup,
  CoreSchedule.PostStartup
]);

export const FRAME_BEFORE_FIXED_SCHEDULES: readonly CoreSchedule[] = Object.freeze([
  CoreSchedule.First,
  CoreSchedule.PreUpdate
]);

export const FIXED_SCHEDULES: readonly CoreSchedule[] = Object.freeze([
  CoreSchedule.FixedFirst,
  CoreSchedule.FixedPreUpdate,
  CoreSchedule.FixedUpdate,
  CoreSchedule.FixedPostUpdate,
  CoreSchedule.FixedLast
]);

export const FRAME_AFTER_FIXED_SCHEDULES: readonly CoreSchedule[] = Object.freeze([
  CoreSchedule.Update,
  CoreSchedule.PostUpdate,
  CoreSchedule.Last,
  CoreSchedule.PreRender,
  CoreSchedule.Render,
  CoreSchedule.PostRender
]);

export const LifecycleDiagnosticCode = Object.freeze({
  AppStartupFailed: 'APP_STARTUP_FAILED',
  AppRuntimeFailed: 'APP_RUNTIME_FAILED',
  PluginShutdownFailed: 'PLUGIN_SHUTDOWN_FAILED',
  FrameCleanupFailed: 'FRAME_CLEANUP_FAILED',
  ServiceDisposalFailed: 'SERVICE_DISPOSAL_FAILED',
  ContributionCleanupFailed: 'CONTRIBUTION_CLEANUP_FAILED',
  ScheduleValidationFailed: 'SCHEDULE_VALIDATION_FAILED'
} as const);

export type LifecycleDiagnosticCode =
  (typeof LifecycleDiagnosticCode)[keyof typeof LifecycleDiagnosticCode];
