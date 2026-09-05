export { inspectPixelReadback } from './oracle';
export { createBrowserBackendResult } from './browser-result';
export { createBrowserDoctorProbe } from './browser-probe';
export { classifyDoctorVerdict, renderDoctorReport } from './report';
export { runDoctor, type DoctorBackendProbe } from './run-doctor';
export type {
  DoctorBackend,
  DoctorBackendResult,
  DoctorBackendStatus,
  DoctorReport,
  DoctorStageResult,
  DoctorStageStatus,
  DoctorVerdict,
  PixelReadbackInspection
} from './types';
