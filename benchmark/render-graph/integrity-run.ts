import {
  runHistoryDebugReference,
  runHistoryDebugSubject,
  runRenderSystemReference,
  runRenderSystemSubject
} from './integrity-scenarios';

const profile = process.argv.at(-1);
const scales = {
  smoke: { histories: 4, systems: 16 },
  standard: { histories: 16, systems: 64 },
  nightly: { histories: 64, systems: 256 }
} as const;
if (profile !== 'smoke' && profile !== 'standard' && profile !== 'nightly') {
  throw new Error(`Unknown render-graph integrity profile: ${profile ?? '<missing>'}`);
}

const scale = scales[profile];
const history = runHistoryDebugSubject(scale.histories);
const historyReference = runHistoryDebugReference(scale.histories);
const systems = runRenderSystemSubject(scale.systems);
const systemsReference = runRenderSystemReference(scale.systems);
if (JSON.stringify(history) !== JSON.stringify(historyReference)) {
  throw new Error('Render-graph history debug state does not match its independent oracle');
}
if (JSON.stringify(systems) !== JSON.stringify(systemsReference)) {
  throw new Error('Render-system compilation does not match its independent oracle');
}
console.log(
  `Render-graph integrity: histories=${scale.histories} historyChecksum=${history.checksum} historyCounters=${JSON.stringify(history.counters)} systems=${scale.systems} systemChecksum=${systems.checksum} systemCounters=${JSON.stringify(systems.counters)}`
);
