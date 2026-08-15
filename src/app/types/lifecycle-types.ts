export type AppState =
  | 'created'
  | 'building'
  | 'waiting-ready'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'destroyed';

export interface LifecycleDiagnostic {
  readonly code:
    | 'APP_STARTUP_FAILED'
    | 'APP_RUNTIME_FAILED'
    | 'PLUGIN_SHUTDOWN_FAILED'
    | 'FRAME_CLEANUP_FAILED'
    | 'SERVICE_DISPOSAL_FAILED'
    | 'CONTRIBUTION_CLEANUP_FAILED';
  readonly phase:
    | 'startup'
    | 'runtime'
    | 'shutdown'
    | 'frame-cleanup'
    | 'service-disposal'
    | 'contribution-cleanup';
  readonly pluginId?: string;
  readonly error: unknown;
}

export interface DestroyResult {
  readonly diagnostics: readonly LifecycleDiagnostic[];
}
