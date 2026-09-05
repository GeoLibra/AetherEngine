import type { E2EState } from '../../e2e/harness/types';
import { inspectPixelReadback } from './oracle';
import type { DoctorBackend, DoctorBackendResult, DoctorStageResult } from './types';

/** Converts the existing real-render harness outcome into the public Doctor contract. */
export function createBrowserBackendResult(
  backend: DoctorBackend,
  state: E2EState,
  pixels: Uint8Array
): DoctorBackendResult {
  if (state.status !== 'ready') {
    const unsupported =
      state.status === 'failed' &&
      state.graphicsAttempts !== undefined &&
      state.graphicsAttempts.length > 0 &&
      state.graphicsAttempts.every(
        ({ classification }) => classification === 'unavailable' || classification === 'unsupported'
      );
    return Object.freeze({
      backend,
      status: unsupported ? 'unsupported' : state.status === 'failed' ? 'failed' : 'unverified',
      stages: Object.freeze([
        stage(
          'adapter-device-surface',
          state.status === 'failed' ? 'failed' : 'skipped',
          state.status === 'failed' ? state.message : `Harness ended in ${state.status} state.`
        )
      ])
    });
  }
  if (state.backend !== backend) {
    return Object.freeze({
      backend,
      status: 'failed',
      stages: Object.freeze([
        stage(
          'adapter-device-surface',
          'failed',
          `Requested ${backend}, received ${state.backend}.`
        )
      ])
    });
  }

  const inspection = inspectPixelReadback(pixels);
  const renderPassed =
    positiveNumber(state.detail.renderPasses) &&
    positiveNumber(state.detail.nativeQueueSubmits) &&
    webgpuValidationPassed(backend, state.detail.validationErrors) &&
    webgl2ValidationPassed(backend, state.detail.glErrors);
  const stages = [
    stage('adapter-device-surface', 'passed', adapterMessage(state.detail), state.detail),
    stage(
      'render-submit',
      renderPassed ? 'passed' : 'failed',
      renderPassed
        ? undefined
        : 'The harness did not observe a validation-clean render pass and native queue submit.'
    ),
    stage(
      'pixel-readback',
      inspection.verified ? 'passed' : 'failed',
      inspection.verified ? inspection.checksum : 'Rendered pixels were empty or uniform.',
      Object.freeze({ ...inspection })
    )
  ];

  return Object.freeze({
    backend,
    status: renderPassed && inspection.verified ? 'verified' : 'unverified',
    stages: Object.freeze(stages)
  });
}

function stage(
  name: string,
  status: DoctorStageResult['status'],
  message?: string,
  detail?: Readonly<Record<string, unknown>>
): DoctorStageResult {
  return Object.freeze({
    name,
    status,
    ...(message ? { message } : {}),
    ...(detail ? { detail } : {})
  });
}

function positiveNumber(value: unknown): boolean {
  return typeof value === 'number' && value > 0;
}

function webgpuValidationPassed(backend: DoctorBackend, value: unknown): boolean {
  return backend !== 'webgpu' || value === 0;
}

function webgl2ValidationPassed(backend: DoctorBackend, value: unknown): boolean {
  return (
    backend !== 'webgl2' ||
    (Array.isArray(value) && value.length > 0 && value.every((error) => error === 0))
  );
}

function adapterMessage(detail: Readonly<Record<string, unknown>>): string | undefined {
  return typeof detail.adapterName === 'string' ? detail.adapterName : undefined;
}
