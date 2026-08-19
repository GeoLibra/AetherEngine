import { describe, expect, test } from 'vitest';
import { defineJobType } from '../../src';

const DecodeMesh = defineJobType({
  id: 'asset.decode-mesh',
  encode: (input: { bytes: ArrayBuffer }) => ({
    payload: input.bytes,
    inputBytes: input.bytes.byteLength,
    decodeBytes: input.bytes.byteLength,
    transfer: [input.bytes]
  }),
  decode: (value: unknown) => value as { vertices: number },
  summarize: (input: { bytes: ArrayBuffer }) => ({ byteLength: input.bytes.byteLength }),
  idempotent: true,
  retryLimit: 1
});

describe('typed job registration', () => {
  test('creates a frozen typed registration with explicit retry and memory policy', () => {
    const bytes = new ArrayBuffer(16);

    expect(DecodeMesh.id).toBe('asset.decode-mesh');
    expect(DecodeMesh.allowSharedMemory).toBe(false);
    expect(DecodeMesh.encode({ bytes })).toEqual({
      payload: bytes,
      inputBytes: 16,
      decodeBytes: 16,
      transfer: [bytes]
    });
    expect(DecodeMesh.decode({ vertices: 3 })).toEqual({ vertices: 3 });
    expect(DecodeMesh.summarize({ bytes })).toEqual({ byteLength: 16 });
    expect(Object.isFrozen(DecodeMesh)).toBe(true);
  });

  test('rejects invalid ids, retry limits, and encoded byte accounting', () => {
    const definition = {
      encode: (_input: string) => ({
        payload: null,
        inputBytes: 0,
        decodeBytes: 0,
        transfer: []
      }),
      decode: (value: unknown) => String(value),
      summarize: (input: string) => ({ input }),
      idempotent: false,
      retryLimit: 0
    };

    expect(() => defineJobType({ ...definition, id: '  ' })).toThrow('must not be empty');
    expect(() =>
      defineJobType({ ...definition, id: 'test.invalid-retry', retryLimit: -1 })
    ).toThrow('retryLimit');

    const InvalidEncoding = defineJobType({
      ...definition,
      id: 'test.invalid-encoding',
      encode: (_input: string) => ({
        payload: null,
        inputBytes: -1,
        decodeBytes: 0,
        transfer: []
      })
    });
    expect(() => InvalidEncoding.encode('input')).toThrow('inputBytes');
  });
});
