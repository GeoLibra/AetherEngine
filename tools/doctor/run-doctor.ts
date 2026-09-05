import { classifyDoctorVerdict } from './report';
import type { DoctorBackend, DoctorBackendResult, DoctorReport } from './types';

export type DoctorBackendProbe = (backend: DoctorBackend) => Promise<DoctorBackendResult>;

/** Runs the preferred backend first and verifies WebGL2 only when fallback is required. */
export async function runDoctor(
  probe: DoctorBackendProbe,
  now: () => number = () => performance.now()
): Promise<DoctorReport> {
  const startedAt = now();
  const results: DoctorBackendResult[] = [];
  const webgpu = await safeProbe(probe, 'webgpu');
  results.push(webgpu);

  if (webgpu.status !== 'verified') {
    results.push(await safeProbe(probe, 'webgl2'));
  }

  return Object.freeze({
    verdict: classifyDoctorVerdict(results),
    durationMs: Math.max(0, now() - startedAt),
    backends: Object.freeze(results)
  });
}

async function safeProbe(
  probe: DoctorBackendProbe,
  backend: DoctorBackend
): Promise<DoctorBackendResult> {
  try {
    return await probe(backend);
  } catch (cause) {
    return Object.freeze({
      backend,
      status: 'failed',
      stages: Object.freeze([
        Object.freeze({
          name: 'probe',
          status: 'failed',
          message: cause instanceof Error ? cause.message : String(cause)
        })
      ])
    });
  }
}
