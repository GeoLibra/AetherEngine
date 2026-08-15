import { runRuntimeIntegrityReference, runRuntimeIntegritySubject } from './integrity-scenarios';

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
console.log(
  `Runtime/jobs integrity: scale=${scale} checksum=${subject.checksum} counters=${JSON.stringify(subject.counters)}`
);
