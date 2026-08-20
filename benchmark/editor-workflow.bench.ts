import { bench, expect } from 'vitest';
import {
  createEditorCommandBatch,
  applyEditorCommandBatch,
  applyEditorCommandsReference
} from './editor-workflow/model';

const profile = process.env.AETHER_BENCH_PROFILE ?? 'smoke';
const counts =
  profile === 'nightly' ? [10_000, 100_000] : profile === 'standard' ? [10_000] : [1_000];

for (const count of counts) {
  const batch = createEditorCommandBatch(count, 0x4242);
  // Verify oracle outside benchmark timing loop
  const reference = applyEditorCommandsReference(batch);
  const subjectCheck = applyEditorCommandBatch(batch);
  expect(subjectCheck.documentRevision).toBe(reference.documentRevision);
  expect(subjectCheck.stateChecksum).toBe(reference.stateChecksum);

  let sink = 0;
  bench(`editor workflow apply ${count} commands`, () => {
    const result = applyEditorCommandBatch(batch);
    sink += result.stateChecksum;
  });

  bench(`editor reference state machine apply ${count} commands`, () => {
    const result = applyEditorCommandsReference(batch);
    sink += result.stateChecksum;
  });
}
