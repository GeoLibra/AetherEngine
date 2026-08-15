import { bench, expect } from 'vitest';
import { createEditorCommandBatch, applyEditorCommandBatch } from './editor-workflow/model';

const profile = process.env.AETHER_BENCH_PROFILE ?? 'smoke';
const counts =
  profile === 'nightly' ? [10_000, 100_000] : profile === 'standard' ? [10_000] : [1_000];

for (const count of counts) {
  const batch = createEditorCommandBatch(count, 0x4242);
  const oracle = applyEditorCommandBatch(batch);

  bench(`editor workflow apply ${count} commands`, () => {
    const result = applyEditorCommandBatch(batch);
    expect(result.documentRevision).toBe(oracle.documentRevision);
    expect(result.stateChecksum).toBe(oracle.stateChecksum);
  });
}
