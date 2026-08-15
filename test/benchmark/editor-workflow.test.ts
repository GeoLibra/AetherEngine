import { describe, expect, test } from 'vitest';
import {
  createEditorCommandBatch,
  applyEditorCommandBatch,
  applyEditorCommandsReference,
  EditorCommandRecord,
  EDITOR_GOLDEN_1000_SEED_4242
} from '../../benchmark/editor-workflow/model';

describe('editor workflow benchmark oracle and state machine reference', () => {
  test('fast subject matches reference document state machine across various workloads', () => {
    const batch = createEditorCommandBatch(200, 0x4242);
    expect(batch).toHaveLength(200);

    const reference = applyEditorCommandsReference(batch);
    const subject = applyEditorCommandBatch(batch);

    expect(subject.totalNodes).toBe(reference.totalNodes);
    expect(subject.selectedCount).toBe(reference.selectedCount);
    expect(subject.documentRevision).toBe(reference.documentRevision);
    expect(subject.stateChecksum).toBe(reference.stateChecksum);
  });

  test('correctly handles 256 and 257+ boundary node capacity growth without data corruption', () => {
    for (const uniqueNodeCount of [256, 257, 512, 513, 1000]) {
      const commands: EditorCommandRecord[] = [];
      for (let i = 0; i < uniqueNodeCount; i++) {
        commands.push({
          id: i + 1,
          type: i % 2 === 0 ? 'transform' : 'modify_property',
          targetId: `boundary_node_${i}`,
          payloadValue: (i * 7) % 100
        });
      }

      const reference = applyEditorCommandsReference(commands);
      const subject = applyEditorCommandBatch(commands, 16); // force multiple reallocations

      expect(subject.totalNodes).toBe(uniqueNodeCount);
      expect(subject.totalNodes).toBe(reference.totalNodes);
      expect(subject.selectedCount).toBe(reference.selectedCount);
      expect(subject.documentRevision).toBe(reference.documentRevision);
      expect(subject.stateChecksum).toBe(reference.stateChecksum);
      expect(subject.stateChecksum).not.toBe(0);
    }
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
