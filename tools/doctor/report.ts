import type { DoctorBackendResult, DoctorReport, DoctorVerdict } from './types';

/** Derives the public verdict from backend probes in preference order. */
export function classifyDoctorVerdict(results: readonly DoctorBackendResult[]): DoctorVerdict {
  const verifiedIndex = results.findIndex(({ status }) => status === 'verified');
  if (verifiedIndex === 0) return 'verified';
  if (verifiedIndex > 0) return 'verified-with-fallback';
  if (results.some(({ status }) => status === 'failed')) return 'failed';
  if (results.some(({ status }) => status === 'unverified')) return 'unverified';
  return 'unsupported';
}

/** Formats a stable human-readable report while preserving structured details in JSON mode. */
export function renderDoctorReport(report: DoctorReport): string {
  const lines = ['Aether Doctor', ''];
  for (const backend of report.backends) {
    lines.push(`${backendLabel(backend.backend)}  ${backend.status.toUpperCase()}`);
    for (const stage of backend.stages) {
      lines.push(
        `  ${stage.name.padEnd(20)} ${stage.status.toUpperCase()}${stage.message ? `  ${stage.message}` : ''}`
      );
    }
    lines.push('');
  }
  lines.push(`Verdict: ${report.verdict.replaceAll('-', ' ').toUpperCase()}`);
  lines.push(`Duration: ${Math.round(report.durationMs)} ms`);
  return `${lines.join('\n')}\n`;
}

function backendLabel(backend: DoctorBackendResult['backend']): string {
  return backend === 'webgpu' ? 'WebGPU' : 'WebGL2';
}
