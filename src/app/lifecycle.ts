import type { LifecycleDiagnostic } from './types';

const DIAGNOSTIC_CODE_BY_PHASE: Readonly<
  Record<LifecycleDiagnostic['phase'], LifecycleDiagnostic['code']>
> = Object.freeze({
  startup: 'APP_STARTUP_FAILED',
  shutdown: 'PLUGIN_SHUTDOWN_FAILED',
  'service-disposal': 'SERVICE_DISPOSAL_FAILED',
  'contribution-cleanup': 'CONTRIBUTION_CLEANUP_FAILED'
});

export function createLifecycleDiagnostic(
  phase: LifecycleDiagnostic['phase'],
  error: unknown,
  pluginId?: string
): LifecycleDiagnostic {
  return Object.freeze(
    pluginId === undefined
      ? { code: DIAGNOSTIC_CODE_BY_PHASE[phase], phase, error }
      : { code: DIAGNOSTIC_CODE_BY_PHASE[phase], phase, pluginId, error }
  );
}
