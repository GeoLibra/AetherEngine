import { describe, expect, test } from 'vitest';
import {
  buildPreparedDrawPhase,
  type PreparedDrawPacket,
  type RenderEntityId,
  type RenderPhaseKind
} from '../../src/rendering';

describe('buildPreparedDrawPhase', () => {
  test('builds an immutable opaque snapshot in canonical state-coherent order', () => {
    const packets = [
      packet(3, { pipelineKey: 'p:b', materialKey: 'm:a', insertionOrder: 2 }),
      packet(2, { pipelineKey: 'p:a', materialKey: 'm:b', insertionOrder: 1 }),
      packet(1, { pipelineKey: 'p:a', materialKey: 'm:a', insertionOrder: 0 })
    ];

    const result = buildPreparedDrawPhase('view:main', 'opaque', packets);

    expect(result.skipped).toEqual([]);
    expect(result.snapshot.packets).toEqual([packets[2], packets[1], packets[0]]);
    expect(result.snapshot.packets[0]).toBe(packets[2]);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.packets)).toBe(true);
  });

  test('preserves transparent depth and overlay insertion semantics', () => {
    const transparent = [
      packet(1, { phase: 'transparent', distance: 2, insertionOrder: 0 }),
      packet(2, { phase: 'transparent', distance: 9, insertionOrder: 1 })
    ];
    const overlay = [
      packet(1, { phase: 'overlay', insertionOrder: 8 }),
      packet(2, { phase: 'overlay', insertionOrder: 2 })
    ];

    expect(
      buildPreparedDrawPhase('view', 'transparent', transparent).snapshot.packets.map(
        ({ entity }) => entity
      )
    ).toEqual([2, 1]);
    expect(
      buildPreparedDrawPhase('view', 'overlay', overlay).snapshot.packets.map(
        ({ entity }) => entity
      )
    ).toEqual([2, 1]);
  });

  test('returns typed skips for mismatched, released, and duplicate queue associations', () => {
    const result = buildPreparedDrawPhase('view', 'opaque', [
      packet(1),
      packet(1),
      packet(2, { phase: 'transparent' }),
      packet(3, { released: true })
    ]);

    expect(result.snapshot.packets.map(({ entity }) => entity)).toEqual([1]);
    expect(result.skipped.map(({ code }) => code)).toEqual([
      'duplicate-draw-association',
      'draw-phase-mismatch',
      'released-draw-packet'
    ]);
  });

  test('fails fast for an empty view identity', () => {
    expect(() => buildPreparedDrawPhase(' ', 'opaque', [])).toThrow(
      'Prepared draw phase view ID must be non-empty.'
    );
  });
});

function packet(
  entity: number,
  overrides: Partial<PreparedDrawPacket> & { phase?: RenderPhaseKind } = {}
): PreparedDrawPacket {
  return Object.freeze({
    entity: entity as RenderEntityId,
    phase: 'opaque',
    pipelineKey: 'p:a',
    materialKey: 'm:a',
    meshKey: 'mesh:a',
    bindingKey: 'binding:a',
    drawKey: 'draw:a',
    distance: 1,
    insertionOrder: 0,
    pipeline: {} as never,
    bindingSet: {} as never,
    vertexBuffers: [],
    indexBuffer: {} as never,
    indexFormat: 'uint16',
    firstIndex: 0,
    indexCount: 3,
    released: false,
    retain() {},
    release() {},
    ...overrides
  });
}
