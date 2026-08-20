export interface EditorCommandRecord {
  readonly id: number;
  readonly type: 'select' | 'transform' | 'modify_property' | 'batch_update';
  readonly targetId: string;
  readonly payloadValue: number;
}

export interface EditorNodeState {
  readonly id: string;
  selected: boolean;
  positionX: number;
  positionY: number;
  positionZ: number;
  opacity: number;
  revision: number;
}

export interface EditorSnapshotState {
  readonly totalNodes: number;
  readonly selectedCount: number;
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
        targetId: `node_${next() % 50}`,
        payloadValue: (next() % 1000) / 10
      })
    );
  }
  return Object.freeze(commands);
}

/**
 * Independent reference document state machine for Editor commands.
 * Implemented with object maps and OOP node instances.
 */
export function applyEditorCommandsReference(
  commands: readonly EditorCommandRecord[]
): EditorSnapshotState {
  const nodes = new Map<string, EditorNodeState>();
  let documentRevision = 0;

  for (const cmd of commands) {
    documentRevision++;
    let node = nodes.get(cmd.targetId);
    if (!node) {
      node = {
        id: cmd.targetId,
        selected: false,
        positionX: 0,
        positionY: 0,
        positionZ: 0,
        opacity: 1.0,
        revision: 0
      };
      nodes.set(cmd.targetId, node);
    }

    node.revision = documentRevision;
    switch (cmd.type) {
      case 'select':
        node.selected = !node.selected;
        break;
      case 'transform':
        node.positionX += cmd.payloadValue;
        node.positionY += cmd.payloadValue * 0.5;
        break;
      case 'modify_property':
        node.opacity = (cmd.payloadValue % 100) / 100;
        break;
      case 'batch_update':
        node.positionZ += cmd.payloadValue;
        node.opacity = 0.5;
        break;
    }
  }

  let selectedCount = 0;
  let checksum = 0;
  for (const node of nodes.values()) {
    if (node.selected) selectedCount++;
    const term = Math.floor(
      node.positionX * 10 +
        node.positionY * 10 +
        node.positionZ * 10 +
        node.opacity * 100 +
        node.revision
    );
    checksum = (checksum + term) | 0;
  }

  return Object.freeze({
    totalNodes: nodes.size,
    selectedCount,
    documentRevision,
    stateChecksum: checksum
  });
}

/**
 * Subject under benchmark: Fast flat-memory SoA state loop for command batches.
 * Dynamically reallocates typed arrays on capacity growth without silent overflow or data corruption.
 */
export function applyEditorCommandBatch(
  commands: readonly EditorCommandRecord[],
  initialCapacity: number = 64
): EditorSnapshotState {
  if (!Number.isSafeInteger(initialCapacity) || initialCapacity <= 0) {
    throw new RangeError(
      `Invalid initialCapacity: expected positive safe integer, got ${String(initialCapacity)}`
    );
  }

  let capacity = Math.max(16, initialCapacity);
  const nodeIndexMap = new Map<string, number>();
  let nodeCount = 0;

  let posX = new Float64Array(capacity);
  let posY = new Float64Array(capacity);
  let posZ = new Float64Array(capacity);
  let opacity = new Float64Array(capacity);
  let selected = new Uint8Array(capacity);
  let revision = new Int32Array(capacity);

  const grow = (): void => {
    const nextCapacity = capacity * 2;
    const nextPosX = new Float64Array(nextCapacity);
    const nextPosY = new Float64Array(nextCapacity);
    const nextPosZ = new Float64Array(nextCapacity);
    const nextOpacity = new Float64Array(nextCapacity);
    const nextSelected = new Uint8Array(nextCapacity);
    const nextRevision = new Int32Array(nextCapacity);

    nextPosX.set(posX);
    nextPosY.set(posY);
    nextPosZ.set(posZ);
    nextOpacity.set(opacity);
    nextSelected.set(selected);
    nextRevision.set(revision);

    posX = nextPosX;
    posY = nextPosY;
    posZ = nextPosZ;
    opacity = nextOpacity;
    selected = nextSelected;
    revision = nextRevision;
    capacity = nextCapacity;
  };

  let documentRevision = 0;

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]!;
    documentRevision++;

    let idx = nodeIndexMap.get(cmd.targetId);
    if (idx === undefined) {
      if (nodeCount >= capacity) {
        grow();
      }
      idx = nodeCount++;
      nodeIndexMap.set(cmd.targetId, idx);
      posX[idx] = 0;
      posY[idx] = 0;
      posZ[idx] = 0;
      opacity[idx] = 1.0;
      selected[idx] = 0;
    }

    revision[idx] = documentRevision;
    switch (cmd.type) {
      case 'select':
        selected[idx] = selected[idx] === 1 ? 0 : 1;
        break;
      case 'transform':
        posX[idx] = posX[idx]! + cmd.payloadValue;
        posY[idx] = posY[idx]! + cmd.payloadValue * 0.5;
        break;
      case 'modify_property':
        opacity[idx] = (cmd.payloadValue % 100) / 100;
        break;
      case 'batch_update':
        posZ[idx] = posZ[idx]! + cmd.payloadValue;
        opacity[idx] = 0.5;
        break;
    }
  }

  let selectedCount = 0;
  let checksum = 0;
  for (let idx = 0; idx < nodeCount; idx++) {
    if (selected[idx] === 1) selectedCount++;
    const term = Math.floor(
      posX[idx]! * 10 + posY[idx]! * 10 + posZ[idx]! * 10 + opacity[idx]! * 100 + revision[idx]!
    );
    checksum = (checksum + term) | 0;
  }

  return Object.freeze({
    totalNodes: nodeCount,
    selectedCount,
    documentRevision,
    stateChecksum: checksum
  });
}

/**
 * Deterministic Golden Checksum for 1,000 commands with seed 0x4242.
 */
export const EDITOR_GOLDEN_1000_SEED_4242 = Object.freeze({
  totalNodes: 50,
  selectedCount: 14,
  documentRevision: 1000,
  stateChecksum: 344070
});
