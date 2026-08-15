import { describe, expect, test } from 'vitest';
import {
  createEditorCommandBatch,
  applyEditorCommandBatch
} from '../../benchmark/editor-workflow/model';

describe('editor workflow benchmark oracle', () => {
  test('applies editor commands predictably', () => {
    const batch = createEditorCommandBatch(50, 0x4242);
    expect(batch).toHaveLength(50);

    const snapshot = applyEditorCommandBatch(batch);
    expect(snapshot.documentRevision).toBe(50);
    expect(typeof snapshot.stateChecksum).toBe('number');
  });
});
