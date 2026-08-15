import { describe, expect, test } from 'vitest';
import {
  createEditorCommandBatch,
  applyEditorCommandBatch,
  applyEditorCommandsReference,
  EDITOR_GOLDEN_1000_SEED_4242
} from '../../benchmark/editor-workflow/model';

describe('editor workflow benchmark oracle and state machine reference', () => {
  test('fast subject matches reference document state machine', () => {
    const batch = createEditorCommandBatch(200, 0x4242);
    expect(batch).toHaveLength(200);

    const reference = applyEditorCommandsReference(batch);
    const subject = applyEditorCommandBatch(batch);

    expect(subject.totalNodes).toBe(reference.totalNodes);
    expect(subject.selectedCount).toBe(reference.selectedCount);
    expect(subject.documentRevision).toBe(reference.documentRevision);
    expect(subject.stateChecksum).toBe(reference.stateChecksum);
  });

  test('matches deterministic hardcoded golden fixture', () => {
    const batch = createEditorCommandBatch(1000, 0x4242);
    const result = applyEditorCommandBatch(batch);

    expect(result.totalNodes).toBe(EDITOR_GOLDEN_1000_SEED_4242.totalNodes);
    expect(result.selectedCount).toBe(EDITOR_GOLDEN_1000_SEED_4242.selectedCount);
    expect(result.documentRevision).toBe(EDITOR_GOLDEN_1000_SEED_4242.documentRevision);
    expect(result.stateChecksum).toBe(EDITOR_GOLDEN_1000_SEED_4242.stateChecksum);
  });
});
