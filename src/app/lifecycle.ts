import { LifecycleDiagnosticCode } from './constants';
import type { LifecycleDiagnostic } from './types';

const DIAGNOSTIC_CODE_BY_PHASE: Readonly<
  Record<LifecycleDiagnostic['phase'], LifecycleDiagnostic['code']>
> = Object.freeze({
  startup: LifecycleDiagnosticCode.AppStartupFailed,
  runtime: LifecycleDiagnosticCode.AppRuntimeFailed,
  shutdown: LifecycleDiagnosticCode.PluginShutdownFailed,
  'frame-cleanup': LifecycleDiagnosticCode.FrameCleanupFailed,
  'service-disposal': LifecycleDiagnosticCode.ServiceDisposalFailed,
  'contribution-cleanup': LifecycleDiagnosticCode.ContributionCleanupFailed,
  'schedule-validation': LifecycleDiagnosticCode.ScheduleValidationFailed
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
