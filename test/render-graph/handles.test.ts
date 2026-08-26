import { describe, expect, test } from 'vitest';
import {
  assertGraphHandle,
  createGraphHandle,
  isGraphHandle
} from '../../src/render-graph/builder';
import type { BufferHandle, TextureHandle } from '../../src/render-graph/types';

const textureHandle: TextureHandle = createGraphHandle('texture', 7, 2, 3);

const bufferHandle: BufferHandle = createGraphHandle('buffer', 7, 4, 1);

describe('render graph handles', () => {
  test('recognizes frozen graph-local typed handles', () => {
    expect(isGraphHandle(textureHandle)).toBe(true);
    expect(Object.isFrozen(textureHandle)).toBe(true);
  });

  test('rejects a wrong-kind handle', () => {
    expect(() => assertGraphHandle(bufferHandle, 7, 'texture')).toThrow(/texture/i);
  });

  test('rejects a foreign graph handle', () => {
    expect(() => assertGraphHandle(textureHandle, 8, 'texture')).toThrow(/foreign graph/i);
  });

  test('rejects a stale handle version', () => {
    expect(() => assertGraphHandle(textureHandle, 7, 'texture', 4)).toThrow(/stale/i);
  });

  test('rejects malformed unknown values before reading handle fields', () => {
    expect(isGraphHandle({ kind: 'texture', graphId: 7, resourceId: 2, version: -1 })).toBe(false);
    expect(() => assertGraphHandle(null, 7, 'texture')).toThrow(/handle/i);
  });

  test('rejects a frozen structural lookalike without internal provenance', () => {
    const forged = Object.freeze({
      kind: 'texture' as const,
      graphId: 7,
      resourceId: 2,
      version: 3
    });

    expect(isGraphHandle(forged)).toBe(false);
    expect(() => assertGraphHandle(forged, 7, 'texture')).toThrow(/handle/i);
  });
});
