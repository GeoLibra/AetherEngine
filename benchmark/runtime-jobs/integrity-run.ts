import { runRuntimeIntegrityReference, runRuntimeIntegritySubject } from './integrity-scenarios';
import {
  runScheduleSystemSetReference,
  runScheduleSystemSetSubject,
  runScheduleCompilationReference,
  runScheduleCompilationSubject,
  runTelemetryOverheadSubject
} from './schedule-scenarios';

const profile = process.argv.at(-1);
const scales = { smoke: 32, standard: 256, nightly: 1024 } as const;
if (profile !== 'smoke' && profile !== 'standard' && profile !== 'nightly') {
  throw new Error(`Unknown runtime/jobs integrity profile: ${profile ?? '<missing>'}`);
}

const scale = scales[profile];
const subject = runRuntimeIntegritySubject(scale);
const reference = runRuntimeIntegrityReference(scale);
if (JSON.stringify(subject) !== JSON.stringify(reference)) {
  throw new Error('Runtime/jobs integrity subject does not match its independent oracle');
}

const setSubject = await runScheduleSystemSetSubject(scale);
const setReference = runScheduleSystemSetReference(scale);
if (JSON.stringify(setSubject) !== JSON.stringify(setReference)) {
  throw new Error('Schedule SystemSet subject does not match its independent oracle');
}

const compileSubject = runScheduleCompilationSubject(scale);
const compileReference = runScheduleCompilationReference(scale);
if (JSON.stringify(compileSubject) !== JSON.stringify(compileReference)) {
  throw new Error('Schedule compilation subject does not match its independent oracle');
}

const disabledTelemetry = await runTelemetryOverheadSubject(false, scale);
if (disabledTelemetry.clockSamples !== 0 || disabledTelemetry.emittedEvents !== 0) {
  throw new Error('Disabled telemetry must have zero clock reads and zero emitted events');
}

console.log(
  `Runtime/jobs integrity: scale=${scale} checksum=${subject.checksum} systemSets=${setSubject.checksum} compiled=${compileSubject.checksum}`
);
