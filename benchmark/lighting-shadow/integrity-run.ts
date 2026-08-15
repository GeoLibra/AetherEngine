import { runShadowAtlasCompactionReference, runShadowAtlasCompactionSubject } from './scenario';

const profile = process.argv.at(-1);
const scales = { smoke: 16, standard: 64, nightly: 256 } as const;
if (profile !== 'smoke' && profile !== 'standard' && profile !== 'nightly') {
  throw new Error(`Unknown lighting/shadow integrity profile: ${profile ?? '<missing>'}`);
}

const count = scales[profile];
const subject = runShadowAtlasCompactionSubject(count, 4);
const reference = runShadowAtlasCompactionReference(count, 4);
if (JSON.stringify(subject) !== JSON.stringify(reference)) {
  throw new Error('Shadow-atlas compaction does not match its independent oracle');
}
console.log(
  `Lighting/shadow integrity: count=${count} checksum=${subject.checksum} counters=${JSON.stringify(subject.counters)}`
);
