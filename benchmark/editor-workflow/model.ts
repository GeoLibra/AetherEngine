export interface EditorCommandRecord {
  readonly id: number;
  readonly type: 'select' | 'transform' | 'modify_property' | 'batch_update';
  readonly targetId: string;
  readonly payloadSize: number;
}

export interface EditorSnapshotState {
  readonly selectionCount: number;
  readonly documentRevision: number;
  readonly stateChecksum: number;
}

export function createEditorCommandBatch(
  count: number,
  seed: number
): readonly EditorCommandRecord[] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };

  const types: readonly EditorCommandRecord['type'][] = [
    'select',
    'transform',
    'modify_property',
    'batch_update'
  ];

  const commands: EditorCommandRecord[] = [];
  for (let i = 0; i < count; i++) {
    commands.push(
      Object.freeze({
        id: i + 1,
        type: types[next() % types.length]!,
        targetId: `node_${next() % 500}`,
        payloadSize: 16 + (next() % 128)
      })
    );
  }
  return Object.freeze(commands);
}

export function applyEditorCommandBatch(
  commands: readonly EditorCommandRecord[]
): EditorSnapshotState {
  let selectionCount = 0;
  let documentRevision = 0;
  let checksum = 0;

  for (const cmd of commands) {
    documentRevision++;
    if (cmd.type === 'select') {
      selectionCount = (selectionCount + 1) % 100;
    }
    checksum = (checksum + cmd.id * 31 + cmd.payloadSize + documentRevision) | 0;
  }

  return Object.freeze({
    selectionCount,
    documentRevision,
    stateChecksum: checksum
  });
}
